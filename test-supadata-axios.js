const axios = require('axios');

const SUPADATA_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6IjEifQ.eyJpc3MiOiJuYWRsZXMiLCJpYXQiOiIxNzQ0NjI1MDAxIiwicHVycG9zZSI6ImFwaV9hdXRoZW50aWNhdGlvbiIsInN1YiI6IjhiZmQ2ZDZjNTEzMzQzNGJhOWQxZTIzZDIxY2U3NWU4In0.w3UZsw6FxkgDkOxL762skwus1DZxJsLiv8rYT3Zn1zE';
const VIDEO_ID = 'KJ2Ba-GY-vk'; // Video requested by user

async function fetchTranscriptFromSupadata(videoId, lang) {
  try {
    console.log(`Fetching transcript for: ${videoId}, language: ${lang || 'default'}`);
    
    let apiUrl = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`;
    
    if (lang) {
      apiUrl += `&lang=${lang}`;
    }
    
    apiUrl += '&text=false';
    
    const options = {
      method: 'GET',
      headers: {
        'x-api-key': SUPADATA_API_KEY
      }
    };
    
    const response = await axios.get(apiUrl, options);
    
    const data = response.data;
    console.log('Available languages:', data.availableLangs);
    console.log('Selected language:', data.lang);
    console.log('Content type:', Array.isArray(data.content) ? 'Array' : typeof data.content);
    console.log('Content sample:', Array.isArray(data.content) 
      ? data.content.slice(0, 3).map(item => `${item.offset}ms: ${item.text}`) 
      : data.content.substring(0, 100));
    
    return data;
  } catch (error) {
    console.error('Error fetching transcript:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

async function runTests() {
  try {
    console.log('\n=== Test 1: Default language ===');
    await fetchTranscriptFromSupadata(VIDEO_ID);
    
    console.log('\n=== Test 2: Japanese language ===');
    await fetchTranscriptFromSupadata(VIDEO_ID, 'ja');
    
    console.log('\n=== Test 3: English language ===');
    await fetchTranscriptFromSupadata(VIDEO_ID, 'en');
    
  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

runTests();
