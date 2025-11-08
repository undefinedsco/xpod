#!/usr/bin/env node

const { PostgresKeyValueStorage } = require('../dist/storage/keyvalue/PostgresKeyValueStorage');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: '.env.server' });

async function testJsonValidation() {
  const storage = new PostgresKeyValueStorage({
    connectionString: process.env.CSS_IDENTITY_DB_URL,
    tableName: 'test_kv',
    namespace: 'test/'
  });

  try {
    await storage.initialize();
    console.log('Testing JSON validation...');

    // Test 1: Valid JSON object
    try {
      await storage.set('valid-object', { name: 'test', value: 123 });
      console.log('✓ Valid object stored successfully');
    } catch (error) {
      console.log('✗ Valid object failed:', error.message);
    }

    // Test 2: Valid string
    try {
      await storage.set('valid-string', 'hello world');
      console.log('✓ Valid string stored successfully');
    } catch (error) {
      console.log('✗ Valid string failed:', error.message);
    }

    // Test 3: Valid array
    try {
      await storage.set('valid-array', [1, 2, 3]);
      console.log('✓ Valid array stored successfully');
    } catch (error) {
      console.log('✗ Valid array failed:', error.message);
    }

    // Test 4: Object with circular reference (should fail)
    try {
      const circular = { name: 'test' };
      circular.self = circular;
      await storage.set('circular', circular);
      console.log('✗ Circular reference should have failed but didn\'t');
    } catch (error) {
      console.log('✓ Circular reference correctly rejected:', error.message);
    }

    // Test 5: Function (should fail)
    try {
      await storage.set('function', function() { return 'test'; });
      console.log('✗ Function should have failed but didn\'t');
    } catch (error) {
      console.log('✓ Function correctly rejected:', error.message);
    }

    // Test 6: Read back valid values
    try {
      const obj = await storage.get('valid-object');
      const str = await storage.get('valid-string');
      const arr = await storage.get('valid-array');
      
      console.log('✓ Retrieved values:');
      console.log('  Object:', obj);
      console.log('  String:', str);
      console.log('  Array:', arr);
    } catch (error) {
      console.log('✗ Failed to retrieve values:', error.message);
    }

  } finally {
    await storage.finalize();
  }
}

testJsonValidation().catch(console.error);