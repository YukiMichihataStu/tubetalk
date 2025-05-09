import { VideoDataError, NoCaptionsVideoDataError, DataAccessVideoDataError, TokenLimitExceededError } from '../errors/VideoDataError';

interface VideoData {
  videoId: string;
  title: string;
  description: string;
  transcript: string;
  timestamp: number;
}


interface SupadataTranscriptResponse {
  content: string | Array<{
    text: string;
    offset: number;
    duration: number;
    lang: string;
  }>;
  lang: string;
  availableLangs: string[];
}

interface CacheEntry {
  data: VideoData;
  expiresAt: number;
}

export class VideoDataService {
  private static CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 1000; // 1 second
  private static OUTPUT_TOKENS = 3000;
  private static MAX_TOKENS = 128000 - VideoDataService.OUTPUT_TOKENS;  // 128k token limit
  private static LANGUAGE_PRIORITY = ['ja', 'en']; // 日本語優先、次に英語
  

  private videoDataCache = new Map<string, CacheEntry>();
  private videoDataRequests = new Map<string, Promise<VideoData>>();
  private currentVideoData: VideoData | null = null;
  private isInitialDataFetch = true;
  private preloadTimeout: number | null = null;

  private logCacheStatus(videoId: string, action: string, details?: string) {
    const cacheSize = this.videoDataCache.size;
    const activeRequests = this.videoDataRequests.size;
    const cachedIds = Array.from(this.videoDataCache.keys());
    
    console.log(`[VideoDataService] ${action}`, {
      videoId,
      cacheSize,
      activeRequests,
      cachedIds,
      ...(details ? { details } : {})
    });
  }

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  
  private async fetchTranscriptFromSupadata(videoId: string, lang?: string, retryCount = 0): Promise<SupadataTranscriptResponse> {
    try {
      console.log(`[VideoDataService] Fetching transcript from Supadata API for: ${videoId}, language: ${lang || 'default'}, attempt ${retryCount + 1}`);
      
      let apiUrl = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`;
      
      if (lang) {
        apiUrl += `&lang=${lang}`;
      }
      
      apiUrl += '&text=false';
      
      const options = {
        method: 'GET',
        headers: {
          'x-api-key': 'YOUR_API_KEY_HERE' // 実際の実装では環境変数から取得
        }
      };
      
      const response = await fetch(apiUrl, options);
      
      if (!response.ok) {
        throw new Error(`Supadata API error: ${response.status}`);
      }
      
      console.log(`[VideoDataService] Supadata transcript fetch successful`);
      return await response.json();
    } catch (error) {
      if (retryCount < VideoDataService.MAX_RETRIES) {
        console.log(`[VideoDataService] Supadata transcript fetch failed, retrying in ${VideoDataService.RETRY_DELAY}ms`);
        await new Promise(resolve => setTimeout(resolve, VideoDataService.RETRY_DELAY));
        return this.fetchTranscriptFromSupadata(videoId, lang, retryCount + 1);
      }
      throw error;
    }
  }

  private async fetchTranscript(playerResponse: any): Promise<string> {
    const videoId = playerResponse.videoDetails?.videoId;
    if (!videoId) {
      throw new NoCaptionsVideoDataError();
    }

    console.log(`[VideoDataService] Fetching transcript for video: ${videoId}`);
    
    try {
      let transcriptData: SupadataTranscriptResponse | null = null;
      let error: Error | null = null;
      
      try {
        transcriptData = await this.fetchTranscriptFromSupadata(videoId);
        console.log(`[VideoDataService] Got transcript with no language specified, lang: ${transcriptData.lang}`);
      } catch (e) {
        error = e as Error;
        console.log(`[VideoDataService] Failed to get transcript with no language specified: ${error.message}`);
      }
      
      if (!transcriptData) {
        for (const lang of VideoDataService.LANGUAGE_PRIORITY) {
          try {
            transcriptData = await this.fetchTranscriptFromSupadata(videoId, lang);
            console.log(`[VideoDataService] Got transcript with language: ${lang}`);
            break;
          } catch (e) {
            error = e as Error;
            console.log(`[VideoDataService] Failed to get transcript with language ${lang}: ${error.message}`);
          }
        }
      }
      
      if (!transcriptData) {
        throw error || new NoCaptionsVideoDataError();
      }
      
      if (Array.isArray(transcriptData.content)) {
        const lines = transcriptData.content.map((segment: any) => {
          const startTime = this.formatTime(segment.offset);
          return { startTime, text: segment.text.trim() };
        }).filter((line: any) => line.text);
        
        console.log(`[VideoDataService] Processed transcript lines:`, lines.length);
        return lines.map((line: any) => `${line.startTime} - ${line.text}`).join('\n');
      } 
      else if (typeof transcriptData.content === 'string') {
        console.log(`[VideoDataService] Received plain text transcript without timestamps`);
        return transcriptData.content;
      }
      
      throw new DataAccessVideoDataError('Invalid transcript data format');
    } catch (error) {
      if (error instanceof VideoDataError) {
        throw error;
      }
      throw new DataAccessVideoDataError(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private getPlayerResponseFromWindow(videoId: string): any | null {
    const w = window as any;
    if (w.ytInitialPlayerResponse && w.ytInitialPlayerResponse.videoDetails) {
      const pr = w.ytInitialPlayerResponse;
      if (pr.videoDetails.videoId === videoId) {
        return pr;
      }
    }
    return null;
  }

  private async fetchPlayerResponseFromHTML(videoId: string): Promise<any> {
    let response: Response;
    try {
      response = await fetch('https://www.youtube.com/watch?v=' + videoId);
    } catch (error) {
      // If network fails
      throw new DataAccessVideoDataError('Network error');
    }

    if (!response.ok) {
      throw new DataAccessVideoDataError('Failed to fetch video page');
    }

    const html = await response.text();
    // Use a more robust regex to match across multiple lines
    const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]+?})\s*;/);
    if (!playerResponseMatch) {
      throw new DataAccessVideoDataError('No ytInitialPlayerResponse found in HTML');
    }

    let playerResponse: any;
    try {
      playerResponse = JSON.parse(playerResponseMatch[1]);
    } catch (error) {
      throw new DataAccessVideoDataError('Invalid ytInitialPlayerResponse JSON');
    }

    if (!playerResponse.videoDetails || playerResponse.videoDetails.videoId !== videoId) {
      throw new DataAccessVideoDataError('Invalid or mismatched video ID in playerResponse');
    }
    return playerResponse;
  }

  private async fetchVideoDataFromAPI(videoId: string): Promise<VideoData> {
    console.log(`[VideoDataService] Getting video data for:`, videoId);
    try {
      let playerResponse = this.getPlayerResponseFromWindow(videoId);

      if (!playerResponse) {
        console.log(`[VideoDataService] Player response not found in window, fetching HTML`);
        playerResponse = await this.fetchPlayerResponseFromHTML(videoId);
      }

      const videoDetails = playerResponse.videoDetails;
      const title = videoDetails?.title || '';
      const description = videoDetails?.shortDescription || '';

      console.log(`[VideoDataService] Got video details:`, { title, descriptionLength: description.length });

      const transcript = await this.fetchTranscript(playerResponse);

      return {
        videoId,
        title,
        description,
        transcript,
        timestamp: Date.now()
      };
    } catch (error: any) {
      if (error instanceof VideoDataError) {
        throw error;
      }
      throw new DataAccessVideoDataError(error.message || 'Unknown data access error');
    }
  }

  private countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async checkTokenLimit(title: string, description: string, transcript: string): Promise<void> {
    const totalContent = `${title}\n${description}\n${transcript}`;
    const tokenCount = this.countTokens(totalContent);
    
    if (tokenCount > VideoDataService.MAX_TOKENS) {
      console.log(`[VideoDataService] Token limit exceeded: ${tokenCount} tokens`);
      throw new TokenLimitExceededError();
    }
  }

  public async fetchVideoData(videoId: string): Promise<VideoData> {
    if (!videoId) {
      throw new Error('No video ID provided');
    }

    const cachedEntry = this.videoDataCache.get(videoId);
    if (cachedEntry) {
      const isExpired = cachedEntry.expiresAt <= Date.now();
      this.logCacheStatus(videoId, isExpired ? 'Cache expired' : 'Cache hit', 
        `Expires in ${Math.round((cachedEntry.expiresAt - Date.now()) / 1000)}s`);
      
      if (!isExpired) {
        return cachedEntry.data;
      }
    }

    const existingRequest = this.videoDataRequests.get(videoId);
    if (existingRequest) {
      this.logCacheStatus(videoId, 'Using existing request');
      return existingRequest;
    }

    if (this.currentVideoData && 
        this.currentVideoData.videoId === videoId && 
        !this.isInitialDataFetch) {
      this.logCacheStatus(videoId, 'Using current video data');
      return this.currentVideoData;
    }

    this.logCacheStatus(videoId, 'Cache miss, fetching from API');
    
    const fetchAndValidate = async () => {
      const videoData = await this.fetchVideoDataFromAPI(videoId);
      await this.checkTokenLimit(
        videoData.title,
        videoData.description,
        videoData.transcript
      );

      this.videoDataCache.set(videoId, {
        data: videoData,
        expiresAt: Date.now() + VideoDataService.CACHE_DURATION
      });

      if (videoId === videoId) {
        this.currentVideoData = videoData;
        this.isInitialDataFetch = false;
      }

      this.logCacheStatus(videoId, 'Successfully cached video data');
      return videoData;
    };

    const requestPromise = new Promise<VideoData>((resolve, reject) => {
      fetchAndValidate()
        .then(resolve)
        .catch((error) => {
          this.logCacheStatus(videoId, 'Error fetching video data', error instanceof Error ? error.message : 'Unknown error');
          reject(error);
        })
        .finally(() => {
          this.videoDataRequests.delete(videoId);
        });
    });

    this.videoDataRequests.set(videoId, requestPromise);
    return requestPromise;
  }

  public preloadVideoData(videoId: string): void {
    if (this.preloadTimeout) {
      window.clearTimeout(this.preloadTimeout);
    }

    this.preloadTimeout = window.setTimeout(() => {
      console.log(`[VideoDataService] Preloading video data for:`, videoId);
      this.fetchVideoData(videoId).catch(() => {});
      this.preloadTimeout = null;
    }, 100);
  }

  public resetState(): void {
    this.logCacheStatus('', 'Resetting state');
    this.currentVideoData = null;
    this.isInitialDataFetch = true;
    this.videoDataRequests.clear();
    this.videoDataCache.clear();
    if (this.preloadTimeout) {
      window.clearTimeout(this.preloadTimeout);
      this.preloadTimeout = null;
    }
  }

  public clearCache(): void {
    this.logCacheStatus('', 'Clearing cache');
    this.videoDataCache.clear();
  }
}

export const videoDataService = new VideoDataService();
