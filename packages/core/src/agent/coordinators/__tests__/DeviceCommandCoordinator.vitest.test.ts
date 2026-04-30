/**
 * DeviceCommandCoordinator Unit Tests
 *
 * Tests for Device Layer coordinator - device command execution with timeout handling
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { DeviceCommandCoordinator } from '../DeviceCommandCoordinator.js'
import type { ResourceManager } from '../../../resource/ResourceManager.js'
import type { EventEmitter } from '../../../events/EventEmitter.js'
import { EventType } from '@active-collaboration/shared'
import type { Device } from '@active-collaboration/shared'
import type { DeviceCommandResult } from '../DeviceCommandCoordinator.js'

// Helper functions to create mocks
const createMockResourceManager = (): ResourceManager => {
  return {
    registerDevice: vi.fn(),
    getCount: vi.fn().mockReturnValue(0),
    getAllResources: vi.fn().mockReturnValue([]),
    getAllDevices: vi.fn().mockReturnValue([]),
    getResourceById: vi.fn(),
    unregisterDevice: vi.fn(),
  } as unknown as ResourceManager
}

const createMockEventEmitter = (): EventEmitter => {
  return {
    emit: vi.fn().mockReturnValue({
      id: 'event-123',
      type: EventType.DEVICE_OPERATION_EXECUTED,
      source: 'agent-1',
      timestamp: new Date(),
    }),
    emitStateChange: vi.fn(),
    emitError: vi.fn(),
    emitWarning: vi.fn(),
    getEmitterId: vi.fn().mockReturnValue('agent-1'),
    getEventManager: vi.fn(),
  } as unknown as EventEmitter
}

/**
 * Extended device interface for testing (includes executeCommand method)
 */
interface TestDevice extends Device {
  executeCommand: (commandName: string, params?: any) => Promise<any>;
}

const createTestDevice = (overrides: Partial<TestDevice> = {}): TestDevice => {
  return {
    id: 'device-1',
    name: 'Test Device',
    type: 'sensor',
    status: 'online',
    location: { x: 0, y: 0, z: 0 },
    capabilities: [
      { name: 'readTemperature', type: 'read', parameters: [] },
    ],
    executeCommand: vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return { success: true, result: { temperature: 22.5 } }
    }),
    ...overrides
  } as TestDevice
}

describe('DeviceCommandCoordinator', () => {
  let coordinator: DeviceCommandCoordinator
  let mockResourceManager: ResourceManager
  let mockEventEmitter: EventEmitter

  const agentId = 'agent-1'

  beforeEach(() => {
    vi.clearAllMocks()
    mockResourceManager = createMockResourceManager()
    mockEventEmitter = createMockEventEmitter()

    coordinator = new DeviceCommandCoordinator(
      mockResourceManager,
      mockEventEmitter,
      agentId
    )
  })

  describe('Constructor', () => {
    it('should create coordinator with all dependencies', () => {
      expect(coordinator).toBeDefined()
    })
  })

  describe('executeCommand', () => {
    it('should execute command on device successfully', async () => {
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand(
        'device-1',
        'readTemperature',
        {}
      )

      expect(result.success).toBe(true)
      expect(result.result).toBeDefined()
      expect(result.executionTime).toBeGreaterThanOrEqual(0)
    })

    it('should emit DEVICE_OPERATION_EXECUTED event', async () => {
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      await coordinator.executeCommand('device-1', 'readTemperature', {})

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.DEVICE_OPERATION_EXECUTED,
        expect.objectContaining({
          agentId: agentId
        })
      )
    })

    it('should return error for non-existent device', async () => {
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([])

      const result = await coordinator.executeCommand(
        'non-existent-device',
        'someCommand',
        {}
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should handle device command execution errors', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockRejectedValue(new Error('Command failed'))
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'invalidCommand', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Command failed')
    })

    it('should handle device without executeCommand method', async () => {
      const device = createTestDevice({
        executeCommand: undefined
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'someCommand', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('does not support command execution')
    })
  })

  describe('getAllDevices', () => {
    it('should return all devices from resource manager', () => {
      const devices = [createTestDevice(), createTestDevice({ id: 'device-2' })]
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue(devices)

      const result = coordinator.getAllDevices()

      expect(result).toEqual(devices)
      expect(mockResourceManager.getAllDevices).toHaveBeenCalled()
    })

    it('should return empty array when no devices', () => {
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([])

      const result = coordinator.getAllDevices()

      expect(result).toEqual([])
    })
  })

  describe('getDevice', () => {
    it('should return device by ID', () => {
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = coordinator.getDevice('device-1')

      expect(result).toEqual(device)
    })

    it('should return undefined for non-existent device', () => {
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([])

      const result = coordinator.getDevice('non-existent')

      expect(result).toBeUndefined()
    })
  })

  describe('Edge Cases', () => {
    it('should handle command with parameters', async () => {
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const params = { threshold: 25, unit: 'celsius' }
      const result = await coordinator.executeCommand(
        'device-1',
        'setThreshold',
        params
      )

      expect(result.success).toBe(true)
      expect(device.executeCommand).toHaveBeenCalledWith('setThreshold', params)
    })

    it('should handle multiple devices and find correct one', async () => {
      const device1 = createTestDevice({ id: 'device-1' })
      const device2 = createTestDevice({ id: 'device-2' })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device1, device2])

      const result = await coordinator.executeCommand('device-2', 'readTemperature', {})

      expect(result.success).toBe(true)
      expect(device2.executeCommand).toHaveBeenCalled()
      expect(device1.executeCommand).not.toHaveBeenCalled()
    })

    it('should measure execution time', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return { success: true }
        })
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'slowCommand', {})

      expect(result.executionTime).toBeGreaterThanOrEqual(10)
    })
  })

  describe('Timeout Handling', () => {
    it('should timeout slow command execution', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 5000))
          return { success: true }
        })
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand(
        'device-1',
        'slowCommand',
        {},
        100
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
      expect(result.executionTime).toBeGreaterThanOrEqual(100)
    })

    it('should allow custom timeout', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 3000))
          return { success: true }
        })
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand(
        'device-1',
        'slowCommand',
        {},
        5000
      )

      expect(result.success).toBe(true)
      expect(result.executionTime).toBeGreaterThanOrEqual(3000)
    })

    it('should clear timeout on fast execution', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return { success: true }
        })
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand(
        'device-1',
        'fastCommand',
        {},
        5000
      )

      expect(result.success).toBe(true)
      expect(result.executionTime).toBeLessThan(5000)
    })
  })

  describe('Performance', () => {
    it('should make decisions within reasonable time', async () => {
      const startTime = Date.now()
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'fastCommand', {})
      const executionTime = Date.now() - startTime

      expect(executionTime).toBeLessThan(100)
    })
  })
})
