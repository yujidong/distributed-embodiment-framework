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

    // T70 (R8, u1-F2): a SimulatedDevice reports an unknown/unservable
    // command as a RESULT OBJECT ({success:false, error}) — it does not
    // throw. The device-level verdict IS the verdict: the coordinator must
    // surface success:false, never mask it behind a top-level success:true
    // (the R8 three-face contradiction: reply ✓ + "not exposed" + executed
    // audit row about one command).
    it('T70: a device-level failure RESULT propagates as success:false (never a fake success)', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockResolvedValue({
          success: false,
          error: "Unknown command 'set-temperature' for device 'device-1' (accepts: temperature-control, turn-on, turn-off)",
        }),
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'set-temperature', { targetTemperature: 25 })

      expect(result.success).toBe(false)
      expect(result.error).toContain('set-temperature')
      expect(result.result).toMatchObject({ success: false })
    })

    it('T70: the failure echo carries success:false so the audit dedupe can never land an executed row', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockResolvedValue({ success: false, error: 'not accepted' }),
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      await coordinator.executeCommand('device-1', 'set-temperature', {})

      // The seam's audit filter drops DEVICE_OPERATION_EXECUTED payloads with
      // `result.success === false` (sim-registry/seams.ts) — the echo must
      // carry BOTH the failing result and an explicit success:false flag.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.DEVICE_OPERATION_EXECUTED,
        expect.objectContaining({ success: false, result: { success: false, error: 'not accepted' } })
      )
    })

    it('T70: a device result without a success field still counts as success (legacy devices)', async () => {
      const device = createTestDevice({
        executeCommand: vi.fn().mockResolvedValue({ ok: true, temperature: 22.5 }),
      })
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand('device-1', 'readTemperature', {})

      expect(result.success).toBe(true)
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
      // R17 params-purity: without an actor the invocation context is
      // explicitly undefined (never a {} merged into params).
      expect(device.executeCommand).toHaveBeenCalledWith('setThreshold', params, undefined)
    })

    it('threads the invocation-context actor as the third argument (R17)', async () => {
      const device = createTestDevice()
      ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

      const result = await coordinator.executeCommand(
        'device-1',
        'lock',
        undefined,
        { actor: 'security-guard' }
      )

      expect(result.success).toBe(true)
      expect(device.executeCommand).toHaveBeenCalledWith('lock', undefined, { actor: 'security-guard' })
      // The actor rides the bus event as dedicated context — never params.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.DEVICE_OPERATION_EXECUTED,
        expect.objectContaining({ actor: 'security-guard', params: undefined })
      )
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
      // DevLoop R21 test-debt: the wall-clock pair (real 10ms sleep +
      // `executionTime >= 10` assertion) flaked under parallel full-suite
      // load (Node timers can fire a hair early / Date.now rounding yields
      // 9ms). Fake timers make the coordinator's Date.now-based measurement
      // exact: advance exactly 10ms → executionTime === 10.
      vi.useFakeTimers()
      try {
        const device = createTestDevice({
          executeCommand: vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10))
            return { success: true }
          })
        })
        ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

        const pending = coordinator.executeCommand('device-1', 'slowCommand', {})
        await vi.advanceTimersByTimeAsync(10)
        const result = await pending

        expect(result.executionTime).toBeGreaterThanOrEqual(10)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Timeout Handling', () => {
    it('should timeout slow command execution', async () => {
      // Fake timers (R21 test-debt): the real-timer version waited out a
      // 100ms wall-clock timeout and asserted `executionTime >= 95` with a
      // jitter epsilon — load-flaky. Advancing time makes both the timeout
      // firing and the measured duration exact.
      vi.useFakeTimers()
      try {
        const device = createTestDevice({
          executeCommand: vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 5000))
            return { success: true }
          })
        })
        ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

        const pending = coordinator.executeCommand(
          'device-1',
          'slowCommand',
          {},
          { timeout: 100 }
        )
        await vi.advanceTimersByTimeAsync(100)
        const result = await pending

        expect(result.success).toBe(false)
        expect(result.error).toContain('timed out')
        expect(result.executionTime).toBeGreaterThanOrEqual(100)
      } finally {
        vi.useRealTimers()
      }
    })

    it('should allow custom timeout', async () => {
      // Fake timers (R21 test-debt): was a real 3000ms wait.
      vi.useFakeTimers()
      try {
        const device = createTestDevice({
          executeCommand: vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 3000))
            return { success: true }
          })
        })
        ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

        const pending = coordinator.executeCommand(
          'device-1',
          'slowCommand',
          {},
          { timeout: 5000 }
        )
        await vi.advanceTimersByTimeAsync(3000)
        const result = await pending

        expect(result.success).toBe(true)
        expect(result.executionTime).toBeGreaterThanOrEqual(3000)
      } finally {
        vi.useRealTimers()
      }
    })

    it('should clear timeout on fast execution', async () => {
      // Fake timers (R21 test-debt): proves the timeout does NOT reject an
      // already-settled race — advance past both the 10ms device sleep and
      // (after settlement) past the 5000ms timeout to show no late firing.
      vi.useFakeTimers()
      try {
        const device = createTestDevice({
          executeCommand: vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10))
            return { success: true }
          })
        })
        ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

        const pending = coordinator.executeCommand(
          'device-1',
          'fastCommand',
          {},
          { timeout: 5000 }
        )
        await vi.advanceTimersByTimeAsync(10)
        const result = await pending
        await vi.advanceTimersByTimeAsync(5000) // late timer must be inert

        expect(result.success).toBe(true)
        expect(result.executionTime).toBeLessThan(5000)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Performance', () => {
    it('should make decisions within reasonable time', async () => {
      // Fake timers (R21 test-debt): the external `Date.now()` wall-clock
      // bound (<100ms) flaked under parallel load; with the mocked clock the
      // measured duration equals the advanced time exactly.
      vi.useFakeTimers()
      try {
        const startTime = Date.now()
        const device = createTestDevice()
        ;(mockResourceManager.getAllDevices as Mock).mockReturnValue([device])

        const pending = coordinator.executeCommand('device-1', 'fastCommand', {})
        await vi.advanceTimersByTimeAsync(10)
        const result = await pending
        const executionTime = Date.now() - startTime

        expect(executionTime).toBeLessThan(100)
        expect(result.success).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
