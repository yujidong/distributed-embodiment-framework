/**
 * Multi-User Environment Center Unit Tests
 *
 * Tests for multi-user environment functionality:
 * - Member management
 * - Ownership tracking
 * - Multi-user visibility
 * - Environment properties
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { EnvironmentCenter } from './EnvironmentCenter.js';
import type { EnvironmentCenterData } from './types.js';
import type { Device } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('EnvironmentCenter.multiuser.vitest.test');
describe('EnvironmentCenter - Multi-User Support', () => {
  let environment: EnvironmentCenter;
  let envData: EnvironmentCenterData;

  beforeEach(() => {
    // Create a fresh environment for each test
    const now = new Date();
    envData = {
      id: uuidv4(),
      name: 'Test Shared Environment',
      description: 'Test environment for multi-user testing',
      environmentType: 'shared',
      visibility: 'platform',
      createdBy: 'user-creator',
      accessConfig: {},
      createdAt: now,
      updatedAt: now,
    };
    environment = new EnvironmentCenter(envData);
  });

  describe('Member Management', () => {
    it('should add member to environment', () => {
      // Arrange
      const userId = 'user-a';
      const role = 'member';

      // Act
      environment.addMember(userId, role);

      // Assert
      expect(environment.isMember(userId)).toBe(true);
      expect(environment.getMemberRole(userId)).toBe(role);
      expect(environment.listMembers().length).toBe(2); // creator + new member
      logger.info('✅ Test passed: add member to environment');
    });

    it('should prevent duplicate members', () => {
      // Arrange
      const userId = 'user-a';

      // Act
      environment.addMember(userId, 'member');
      environment.addMember(userId, 'admin'); // Try to add again with different role

      // Assert
      expect(environment.isMember(userId)).toBe(true);
      expect(environment.getMemberRole(userId)).toBe('member'); // First role kept
      expect(environment.listMembers().length).toBe(2); // No duplicate
      logger.info('✅ Test passed: prevent duplicate members');
    });

    it('should remove member from environment', () => {
      // Arrange
      const userId = 'user-a';
      environment.addMember(userId, 'member');

      // Act
      environment.removeMember(userId);

      // Assert
      expect(environment.isMember(userId)).toBe(false);
      expect(environment.getMemberRole(userId)).toBeUndefined();
      logger.info('✅ Test passed: remove member from environment');
    });

    it('should prevent removing creator', () => {
      // Arrange
      const creatorId = envData.createdBy;

      // Act & Assert
      expect(() => {
        environment.removeMember(creatorId);
      }).toThrow('Cannot remove the creator of the environment');
      logger.info('✅ Test passed: prevent removing creator');
    });

    it('should check membership correctly', () => {
      // Arrange
      const memberUserId = 'user-member';
      const nonMemberUserId = 'user-non-member';
      environment.addMember(memberUserId, 'member');

      // Act & Assert
      expect(environment.isMember(envData.createdBy)).toBe(true); // Creator is member
      expect(environment.isMember(memberUserId)).toBe(true); // Added member
      expect(environment.isMember(nonMemberUserId)).toBe(false); // Non-member
      logger.info('✅ Test passed: check membership correctly');
    });

    it('should get member role correctly', () => {
      // Arrange
      const adminUserId = 'user-admin';
      const memberUserId = 'user-member';
      environment.addMember(adminUserId, 'admin');
      environment.addMember(memberUserId, 'member');

      // Act & Assert
      expect(environment.getMemberRole(envData.createdBy)).toBe('admin'); // Creator is admin
      expect(environment.getMemberRole(adminUserId)).toBe('admin');
      expect(environment.getMemberRole(memberUserId)).toBe('member');
      expect(environment.getMemberRole('user-unknown')).toBeUndefined();
      logger.info('✅ Test passed: get member role correctly');
    });
  });

  describe('Ownership Tracking', () => {
    it('should track device ownership', () => {
      // Arrange
      const ownerId = 'user-a';
      const device = {
        id: 'device-1',
        name: 'Test Device',
        type: 'sensor',
        location: 'test-location',
        status: 'online',
        capabilities: [],
        services: [],
        ownerId, // Track owner
      } as unknown as Device;

      // Act
      environment.registerDevice(device, ownerId);

      // Assert
      const ownerDevices = environment.getDevicesByOwner(ownerId);
      expect(ownerDevices.length).toBe(1);
      expect(ownerDevices[0].id).toBe(device.id);
      logger.info('✅ Test passed: track device ownership');
    });

    it('should track agent ownership', () => {
      // Arrange
      const ownerId = 'user-a';
      const agent = {
        id: 'agent-1',
        name: 'Test Agent',
        type: 'cognitive',
        status: 'idle',
        ownerId, // Track owner
      } as Record<string, unknown> & { id: string; name: string };

      // Act
      environment.registerAgent(agent, ownerId);

      // Assert
      const ownerAgents = environment.getAgentsByOwner(ownerId);
      expect(ownerAgents.length).toBe(1);
      expect(ownerAgents[0].id).toBe(agent.id);
      logger.info('✅ Test passed: track agent ownership');
    });

    it('should group resources by owner', () => {
      // Arrange
      const userA = 'user-a';
      const userB = 'user-b';

      const deviceA = { id: 'device-a', name: 'Device A', ownerId: userA } as unknown as Device;
      const deviceB = { id: 'device-b', name: 'Device B', ownerId: userB } as unknown as Device;
      const agentA = { id: 'agent-a', name: 'Agent A', ownerId: userA } as Record<string, unknown> & { id: string; name: string };
      const agentB = { id: 'agent-b', name: 'Agent B', ownerId: userB } as Record<string, unknown> & { id: string; name: string };

      // Act
      environment.registerDevice(deviceA, userA);
      environment.registerDevice(deviceB, userB);
      environment.registerAgent(agentA, userA);
      environment.registerAgent(agentB, userB);

      // Assert
      const devicesByOwner = environment.getDevicesGroupedByOwner();
      const agentsByOwner = environment.getAgentsGroupedByOwner();

      expect(devicesByOwner[userA].length).toBe(1);
      expect(devicesByOwner[userB].length).toBe(1);
      expect(agentsByOwner[userA].length).toBe(1);
      expect(agentsByOwner[userB].length).toBe(1);
      logger.info('✅ Test passed: group resources by owner');
    });
  });

  describe('Multi-User Visibility', () => {
    it('should show all agents to members', () => {
      // Arrange
      const userA = 'user-a';
      const userB = 'user-b';
      const agentA = { id: 'agent-a', name: 'Agent A', ownerId: userA } as Record<string, unknown> & { id: string; name: string };
      const agentB = { id: 'agent-b', name: 'Agent B', ownerId: userB } as Record<string, unknown> & { id: string; name: string };

      environment.addMember(userA, 'member');
      environment.addMember(userB, 'member');
      environment.registerAgent(agentA, userA);
      environment.registerAgent(agentB, userB);

      // Act
      const visibleAgents = environment.listAgentsVisibleTo(userA);

      // Assert
      expect(visibleAgents.length).toBe(2);
      expect(visibleAgents.some((a: Record<string, unknown>) => a.id === 'agent-a')).toBe(true);
      expect(visibleAgents.some((a: Record<string, unknown>) => a.id === 'agent-b')).toBe(true);
      logger.info('✅ Test passed: show all agents to members');
    });

    it('should show all devices to members', () => {
      // Arrange
      const userA = 'user-a';
      const userB = 'user-b';
      const deviceA = { id: 'device-a', name: 'Device A', ownerId: userA } as unknown as Device;
      const deviceB = { id: 'device-b', name: 'Device B', ownerId: userB } as unknown as Device;

      environment.addMember(userA, 'member');
      environment.addMember(userB, 'member');
      environment.registerDevice(deviceA, userA);
      environment.registerDevice(deviceB, userB);

      // Act
      const visibleDevices = environment.listDevicesVisibleTo(userA);

      // Assert
      expect(visibleDevices.length).toBe(2);
      expect(visibleDevices.some((d: Record<string, unknown>) => d.id === 'device-a')).toBe(true);
      expect(visibleDevices.some((d: Record<string, unknown>) => d.id === 'device-b')).toBe(true);
      logger.info('✅ Test passed: show all devices to members');
    });

    it('should reject non-members from viewing resources', () => {
      // Arrange
      const nonMember = 'user-non-member';

      // Act & Assert
      expect(() => {
        environment.listAgentsVisibleTo(nonMember);
      }).toThrow('is not a member of this environment');

      expect(() => {
        environment.listDevicesVisibleTo(nonMember);
      }).toThrow('is not a member of this environment');
      logger.info('✅ Test passed: reject non-members from viewing resources');
    });
  });

  describe('Environment Properties', () => {
    it('should support shared environment type', () => {
      // Assert
      expect(environment.environmentType).toBe('shared');
      expect(environment.visibility).toBe('platform');
      logger.info('✅ Test passed: support shared environment type');
    });

    it('should support private environment type', () => {
      // Arrange
      const privateEnvData: EnvironmentCenterData = {
        ...envData,
        id: uuidv4(),
        environmentType: 'private',
        visibility: 'private',
      };
      const privateEnv = new EnvironmentCenter(privateEnvData);

      // Assert
      expect(privateEnv.environmentType).toBe('private');
      expect(privateEnv.visibility).toBe('private');
      logger.info('✅ Test passed: support private environment type');
    });

    it('should have correct creator', () => {
      // Assert
      expect(environment.createdBy).toBe('user-creator');
      expect(environment.isMember('user-creator')).toBe(true);
      expect(environment.getMemberRole('user-creator')).toBe('admin');
      logger.info('✅ Test passed: have correct creator');
    });
  });
});
