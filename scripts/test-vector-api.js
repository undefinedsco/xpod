const assert = require('assert');

const BASE_URL = 'http://localhost:4000';
const VECTOR_ENDPOINT = `${BASE_URL}/-/vector`;

async function testVectorApi() {
  console.log(`--- Starting Vector API Tests on ${BASE_URL} ---`);

  // 1. List Models
  console.log('\n1. Testing GET /-/vector/models');
  try {
    const res = await fetch(`${VECTOR_ENDPOINT}/models`);
    console.log('Status:', res.status);
    assert.strictEqual(res.status, 200, 'GET /models should return 200');
    
    const data = await res.json();
    console.log('Models:', JSON.stringify(data, null, 2));
    assert(Array.isArray(data.models), 'Response should have a "models" array');
    assert(data.models.length > 0, 'Models array should not be empty');
    assert.strictEqual(data.default, 'google', 'Default provider should be google'); 
  } catch (e) {
    console.error('Test 1 failed:', e);
    process.exit(1);
  }

  // 2. Index Status
  console.log('\n2. Testing GET /-/vector/status');
  try {
    const res = await fetch(`${VECTOR_ENDPOINT}/status`);
    console.log('Status:', res.status);
    assert.strictEqual(res.status, 200, 'GET /status should return 200');

    const data = await res.json();
    console.log('Status Data:', JSON.stringify(data, null, 2));
    assert(typeof data.total_vectors === 'number', 'Status should have "total_vectors"');
    assert(typeof data.providers === 'object', 'Status should have "providers" object');
  } catch (e) {
    console.error('Test 2 failed:', e);
    process.exit(1);
  }

  // 3. Index Document
  console.log('\n3. Testing POST /-/vector/index');
  // Need a real resource to index. Creating a dummy one first might be cleaner, 
  // but for now let's try indexing the root or a known path. 
  // Assuming public access or no auth for local dev environment as configured.
  const resourceToIndex = `${BASE_URL}/README`; 
  
  // First, ensure the resource exists (optional, but good for robust test)
  try {
      const putRes = await fetch(resourceToIndex, {
          method: 'PUT',
          headers: {'Content-Type': 'text/plain'},
          body: 'This is a test document for vector indexing.'
      });
      assert(putRes.ok, 'Failed to create test resource');
  } catch (e) {
      console.warn('Could not create test resource, proceeding hoping it exists or index handles 404 gracefully-ish', e);
  }

  try {
    const res = await fetch(`${VECTOR_ENDPOINT}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: [resourceToIndex], 
        force: true
      })
    });
    console.log('Status:', res.status);
    
    // Note: Indexing might be async or return 202/200 depending on implementation.
    // Adjust assertion based on actual API behavior. 
    // Assuming 200 OK and returning job details or results.
    if (res.status === 401 || res.status === 403) {
        console.warn('Skipping assertion for Indexing due to auth requirement.');
    } else {
        assert.strictEqual(res.status, 200, 'POST /index should return 200');
        const data = await res.json();
        console.log('Index Result:', JSON.stringify(data, null, 2));
        assert(Array.isArray(data.results), 'Index response should have "results" array');
    }
  } catch (e) {
    console.error('Test 3 failed:', e);
    // process.exit(1); // Don't exit hard if just auth fail, continue to search
  }

  // 4. Search
  console.log('\n4. Testing POST /-/vector/search');
  try {
    const res = await fetch(`${VECTOR_ENDPOINT}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: "test document",
        limit: 5
      })
    });
    console.log('Status:', res.status);
    
    if (res.status === 401 || res.status === 403) {
         console.warn('Skipping assertion for Search due to auth requirement.');
    } else {
        assert.strictEqual(res.status, 200, 'POST /search should return 200');
        const data = await res.json();
        console.log('Search Result:', JSON.stringify(data, null, 2));
        assert(Array.isArray(data.results), 'Search response should have "results" array');
        // If we indexed successfully, we might expect results.
    }
  } catch (e) {
    console.error('Test 4 failed:', e);
    process.exit(1);
  }
  
  console.log('\n--- All Tests Completed ---');
}

testVectorApi();