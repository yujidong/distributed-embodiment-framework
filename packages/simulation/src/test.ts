/**
 * Simulation Package Test Script
 */

import {
  DeviceFactory,
  DeviceTemplateRegistry,
  SimulatedEnvironment,
  TimeManager,
  createScriptedBehavior,
  createToggleScript,
} from './index.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('test');



async function testSimulatedDevice() {
  logger.info('\n🧪 Simulation Package Test');
  logger.info(`⏰ Time: ${new Date().toISOString()}\n`);

  // Test 1: Create Temperature Sensor
  logger.info('=== Test 1: Create Temperature Sensor ===\n');
  const tempSensor = DeviceFactory.createSensor('Living Room Temp', 'temperature', {
    location: 'living-room',
    updateInterval: 2000,
    initialValue: 22,
  });

  logger.info('✅ Temperature sensor created:', tempSensor.name);
  logger.info('   Type:', tempSensor.type);
  logger.info('   Location:', tempSensor.location);

  // Test 2: Read sensor state
  logger.info('\n=== Test 2: Read Sensor State ===\n');
  const state = tempSensor.getState();
  logger.info('✅ Current state:', state);

  const history = tempSensor.getStateHistory(5);
  logger.info('✅ State history entries:', history.length);

  // Test 3: Execute command
  logger.info('\n=== Test 3: Execute Command ===\n');
  const result = await tempSensor.executeCommand('read-temperature');
  logger.info('✅ Command execution result:', result);

  // Test 4: Create Light
  logger.info('\n=== Test 4: Create Smart Light ===\n');
  const light = DeviceFactory.createLight('Bedroom Light', {
    location: 'bedroom',
    initialState: false,
    brightness: 80,
  });

  logger.info('✅ Light created:', light.name);
  logger.info('   Initial state:', light.getState());

  // Test 5: Control Light
  logger.info('\n=== Test 5: Control Light ===\n');
  const turnOnResult = await light.executeCommand('set-state', { on: true });
  logger.info('✅ Turn on result:', turnOnResult);

  const setBrightnessResult = await light.executeCommand('set-brightness', { brightness: 50 });
  logger.info('✅ Set brightness result:', setBrightnessResult);

  logger.info('   New state:', light.getState());

  // Test 6: Create Thermostat
  logger.info('\n=== Test 6: Create Thermostat ===\n');
  const thermostat = DeviceFactory.createThermostat('Main Thermostat', {
    location: 'hallway',
    initialTemp: 20,
    initialTarget: 22,
  });

  logger.info('✅ Thermostat created:', thermostat.name);
  logger.info('   Initial state:', thermostat.getState());

  // Test 7: Control Thermostat
  logger.info('\n=== Test 7: Control Thermostat ===\n');
  const setTargetResult = await thermostat.executeCommand('set-target-temperature', {
    target: 24,
  });
  logger.info('✅ Set target temp result:', setTargetResult);

  const setModeResult = await thermostat.executeCommand('set-mode', { mode: 'heating' });
  logger.info('✅ Set mode result:', setModeResult);

  logger.info('   New state:', thermostat.getState());

  // Test 8: Device Template Registry
  logger.info('\n=== Test 8: Device Template Registry ===\n');
  const templates = DeviceTemplateRegistry.listTemplates();
  logger.info('✅ Available templates:', templates.length);
  templates.forEach((t) => logger.info(`   - ${t.name}: ${t.description}`));

  // Test 9: Create from Template
  logger.info('\n=== Test 9: Create Device from Template ===\n');
  const motionSensor = DeviceTemplateRegistry.createFromTemplate(
    'motion-sensor',
    'Front Door Motion',
    { location: 'entrance' }
  );

  logger.info('✅ Device created from template:', motionSensor.name);
  logger.info('   Type:', motionSensor.type);

  // Test 10: Simulated Environment
  logger.info('\n=== Test 10: Simulated Environment ===\n');
  const env = new SimulatedEnvironment({
    name: 'Test Home',
    timeScale: 10, // 10x speed
  });

  env.addDevice(tempSensor);
  env.addDevice(light);
  env.addDevice(thermostat);

  logger.info('✅ Environment created:', env.name);
  const stats = env.getStats();
  logger.info('   Devices:', stats.deviceCount);
  logger.info('   Time scale:', stats.timeScale);

  // Test 11: Time Manager
  logger.info('\n=== Test 11: Time Manager ===\n');
  const timeMgr = new TimeManager({ timeScale: 100 });
  logger.info('✅ Time manager created');
  logger.info('   Initial time:', timeMgr.getCurrentTime().toISOString());

  timeMgr.start();
  await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms real time
  logger.info('   After 500ms real time:', timeMgr.getCurrentTime().toISOString());
  logger.info('   Simulated elapsed:', timeMgr.getElapsedSimTime(), 'ms');
  logger.info('   Real elapsed:', timeMgr.getElapsedRealTime(), 'ms');

  timeMgr.dispose();

  // Test 12: Device Services
  logger.info('\n=== Test 12: Device Services ===\n');
  const services = tempSensor.getServices();
  logger.info('✅ Temperature sensor services:', services.length);
  services.forEach((s) => logger.info(`   - ${s.name}: ${s.description}`));

  // Test 13: Custom Device with Scripted Behavior
  logger.info('\n=== Test 13: Custom Device with Scripted Behavior ===\n');
  const customDevice = DeviceFactory.createDevice({
    name: 'Custom Test Device',
    type: 'custom',
    initialState: { value: 0 },
    capabilities: [
      {
        name: 'read-value',
        type: 'read' as any,
        parameters: [],
      },
    ],
    behaviors: [
      createScriptedBehavior(
        createToggleScript('active', 1000, 3) // Toggle every 1s, 3 times
      ),
    ],
    location: 'test',
    metadata: { custom: true },
  });

  logger.info('✅ Custom device created:', customDevice.name);
  logger.info('   Initial state:', customDevice.getState());

  await new Promise((resolve) => setTimeout(resolve, 3500)); // Wait for script to complete
  logger.info('   Final state:', customDevice.getState());
  logger.info('   State history entries:', customDevice.getStateHistory().length);

  // Cleanup
  logger.info('\n=== Cleanup ===\n');
  customDevice.dispose();
  env.dispose();

  logger.info('✅ All tests passed!\n');
}

// Run tests
testSimulatedDevice().catch((error) => {
  logger.error('\n❌ Test error:', error);
  process.exit(1);
});
