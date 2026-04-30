/**
 * Manual test script for LLM Integration package
 *
 * Usage:
 *   # Test SiliconFlow (requires SILICONFLOW_API_KEY env var)
 *   node dist/test.js siliconflow
 *
 *   # Test Ollama (requires Ollama running locally)
 *   node dist/test.js ollama
 */

import { LLMClient } from './index.js';

const provider = process.argv[2] || 'siliconflow';

async function testSiliconFlow() {
  console.log('\n=== Testing SiliconFlow Provider ===\n');

  const client = new LLMClient('siliconflow', {
    apiKey: process.env.SILICONFLOW_API_KEY,
  });

  // Health check
  console.log('1. Health check...');
  const isHealthy = await client.healthCheck();
  console.log(`   Result: ${isHealthy ? 'OK' : 'FAILED'}`);

  if (!isHealthy) {
    console.log('   ⚠️  Health check failed, but continuing with test...');
  }

  // Simple chat
  console.log('\n2. Simple chat...');
  try {
    const response = await client.chat({
      messages: [{ role: 'user', content: 'Hello! Can you hear me?' }],
    });
    console.log(`   Response: ${response.content}`);
    console.log(`   Tokens: ${JSON.stringify(response.usage)}`);
    console.log(`   Model: ${response.model}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }

  // Chat with system prompt
  console.log('\n3. Chat with system prompt...');
  try {
    const response = await client.chat({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
      temperature: 0.7,
    });
    console.log(`   Response: ${response.content}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }

  // Quick chat helper
  console.log('\n4. Quick chat helper...');
  try {
    const response = await client.quickChat(
      'Say "Test successful" in exactly those words.'
    );
    console.log(`   Response: ${response}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }
}

async function testOllama() {
  console.log('\n=== Testing Ollama Provider ===\n');

  const client = new LLMClient('ollama', {
    model: process.env.OLLAMA_MODEL || 'llama3.2',
  });

  // Health check
  console.log('1. Health check...');
  const isHealthy = await client.healthCheck();
  console.log(`   Result: ${isHealthy ? 'OK' : 'FAILED'}`);

  if (!isHealthy) {
    console.log('\n   ⚠️  Make sure Ollama is running: ollama serve');
    console.log('   ⚠️  And a model is pulled: ollama pull llama3.2');
    return;
  }

  // Simple chat
  console.log('\n2. Simple chat...');
  try {
    const response = await client.chat({
      messages: [{ role: 'user', content: 'Hello! Can you hear me?' }],
    });
    console.log(`   Response: ${response.content}`);
    console.log(`   Tokens: ${JSON.stringify(response.usage)}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }

  // Chat with system prompt
  console.log('\n3. Chat with system prompt...');
  try {
    const response = await client.chat({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
      temperature: 0.7,
    });
    console.log(`   Response: ${response.content}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }

  // Quick chat helper
  console.log('\n4. Quick chat helper...');
  try {
    const response = await client.quickChat(
      'Say "Test successful" in exactly those words.'
    );
    console.log(`   Response: ${response}`);
  } catch (error) {
    console.error(`   Error: ${error}`);
  }
}

async function main() {
  console.log(`\n🧪 LLM Integration Test Script`);
  console.log(`📍 Provider: ${provider}`);
  console.log(`⏰ Time: ${new Date().toISOString()}`);

  try {
    if (provider === 'ollama') {
      await testOllama();
    } else if (provider === 'siliconflow') {
      await testSiliconFlow();
    } else {
      console.error(`\n❌ Unknown provider: ${provider}`);
      console.log('   Usage: node dist/test.js [ollama|siliconflow]');
      process.exit(1);
    }

    console.log('\n✅ Test completed!\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
