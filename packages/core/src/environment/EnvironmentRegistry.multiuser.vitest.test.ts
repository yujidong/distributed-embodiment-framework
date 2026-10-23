/**
 * Multi-User Environment Registry Unit Tests
 *
 * Tests for multi-user query functionality:
 * - Get environments by creator
 * - Get shared environments
 * - Get environments by member
 * - Get visible environments for user
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { EnvironmentRegistry, environmentRegistry } from './EnvironmentRegistry.js';
import type { EnvironmentCenterData } from './types.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('EnvironmentRegistry.multiuser.vitest.test');
describe('EnvironmentRegistry - Multi-User Queries', () => {
  let registry: EnvironmentRegistry;
  const now = new Date();

  beforeEach(() => {
    // Use a fresh registry for each test
    registry = new EnvironmentRegistry();
  });

  afterEach(() => {
    // Clean up
    registry.clear();
  });

  const createEnvData = (overrides: Partial<EnvironmentCenterData> = {}): EnvironmentCenterData => ({
    id: uuidv4(),
    name: 'Test Environment',
    description: 'Test description',
    environmentType: 'private',
    visibility: 'private',
    createdBy: 'user-creator',
    accessConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  it('should get environments by creator', () => {
    // Arrange
    const userA = 'user-a';
    const userB = 'user-b';

    const env1 = createEnvData({ createdBy: userA, name: 'Env A1' });
    const env2 = createEnvData({ createdBy: userA, name: 'Env A2' });
    const env3 = createEnvData({ createdBy: userB, name: 'Env B1' });

    registry.register(env1);
    registry.register(env2);
    registry.register(env3);

    // Act
    const userAEnvs = registry.getByCreator(userA);
    const userBEnvs = registry.getByCreator(userB);

    // Assert
    expect(userAEnvs.length).toBe(2);
    expect(userBEnvs.length).toBe(1);
    expect(userAEnvs.every(e => e.createdBy === userA)).toBe(true);
    expect(userBEnvs.every(e => e.createdBy === userB)).toBe(true);
    logger.info('✅ Test passed: get environments by creator');
  });

  it('should get shared environments', () => {
    // Arrange
    const sharedEnv1 = createEnvData({ environmentType: 'shared', visibility: 'platform', name: 'Shared 1' });
    const sharedEnv2 = createEnvData({ environmentType: 'shared', visibility: 'platform', name: 'Shared 2' });
    const privateEnv = createEnvData({ environmentType: 'private', visibility: 'private', name: 'Private' });

    registry.register(sharedEnv1);
    registry.register(sharedEnv2);
    registry.register(privateEnv);

    // Act
    const sharedEnvs = registry.getSharedEnvironments();

    // Assert
    expect(sharedEnvs.length).toBe(2);
    expect(sharedEnvs.every(e => e.environmentType === 'shared')).toBe(true);
    logger.info('✅ Test passed: get shared environments');
  });

  it('should get environments by member', () => {
    // Arrange
    const userA = 'user-a';
    const userB = 'user-b';
    const userC = 'user-c';
    const userD = 'user-d'; // New user who will only be a member (not creator)

    const env1 = createEnvData({ createdBy: userA, name: 'Env 1' });
    const env2 = createEnvData({ createdBy: userB, name: 'Env 2' });

    registry.register(env1);
    registry.register(env2);

    // User D joins env1 (D is only a member, not a creator of any env)
    const env1Center = registry.get(env1.id);
    if (env1Center) {
      env1Center.addMember(userD, 'member');
    }

    // User C joins env2
    const env2Center = registry.get(env2.id);
    if (env2Center) {
      env2Center.addMember(userC, 'member');
    }

    // Act
    const userDEnvs = registry.getEnvironmentsByMember(userD);
    const userCEnvs = registry.getEnvironmentsByMember(userC);

    // Assert
    // userD is only a member of env1 (not a creator of any env)
    expect(userDEnvs.length).toBe(1);
    expect(userDEnvs[0].id).toBe(env1.id);

    // userC is only a member of env2 (not a creator of any env)
    expect(userCEnvs.length).toBe(1);
    expect(userCEnvs[0].id).toBe(env2.id);
    logger.info('✅ Test passed: get environments by member');
  });

  it('should get visible environments for user', () => {
    // Arrange
    const userA = 'user-a';
    const userB = 'user-b';

    // Create different types of environments
    const platformShared = createEnvData({
      environmentType: 'shared',
      visibility: 'platform',
      name: 'Platform Shared',
    });

    const userAPrivate = createEnvData({
      createdBy: userA,
      environmentType: 'private',
      visibility: 'private',
      name: 'User A Private',
    });

    const userBPrivate = createEnvData({
      createdBy: userB,
      environmentType: 'private',
      visibility: 'private',
      name: 'User B Private',
    });

    registry.register(platformShared);
    registry.register(userAPrivate);
    registry.register(userBPrivate);

    // User B joins the platform shared environment
    const sharedCenter = registry.get(platformShared.id);
    if (sharedCenter) {
      sharedCenter.addMember(userB, 'member');
    }

    // Act
    const userAVisible = registry.getVisibleEnvironments(userA);
    const userBVisible = registry.getVisibleEnvironments(userB);

    // Assert for User A
    // Should see: platform shared + own private (not User B's private)
    expect(userAVisible.length).toBeGreaterThanOrEqual(1);
    expect(userAVisible.some(e => e.id === platformShared.id)).toBe(true);
    expect(userAVisible.some(e => e.id === userAPrivate.id)).toBe(true);
    expect(userAVisible.some(e => e.id === userBPrivate.id)).toBe(false);

    // Assert for User B
    // Should see: platform shared + own private (not User A's private)
    expect(userBVisible.length).toBeGreaterThanOrEqual(1);
    expect(userBVisible.some(e => e.id === platformShared.id)).toBe(true);
    expect(userBVisible.some(e => e.id === userBPrivate.id)).toBe(true);
    expect(userBVisible.some(e => e.id === userAPrivate.id)).toBe(false);

    logger.info('✅ Test passed: get visible environments for user');
  });

  it('should handle invite-only environments correctly', () => {
    // Arrange
    const userA = 'user-a';
    const userB = 'user-b';

    const inviteOnlyEnv = createEnvData({
      environmentType: 'shared',
      visibility: 'invite-only',
      name: 'Invite Only',
    });

    registry.register(inviteOnlyEnv);

    // User B is not a member
    // Act
    const userBVisible = registry.getVisibleEnvironments(userB);

    // Assert
    // User B should NOT see invite-only environment (not a member)
    expect(userBVisible.some(e => e.id === inviteOnlyEnv.id)).toBe(false);

    // Now User B joins
    const envCenter = registry.get(inviteOnlyEnv.id);
    if (envCenter) {
      envCenter.addMember(userB, 'member');
    }

    const userBVisibleAfterJoin = registry.getVisibleEnvironments(userB);
    expect(userBVisibleAfterJoin.some(e => e.id === inviteOnlyEnv.id)).toBe(true);

    logger.info('✅ Test passed: handle invite-only environments correctly');
  });

  it('should aggregate all visible environment types', () => {
    // Arrange
    const userA = 'user-a';

    const platformEnv = createEnvData({
      environmentType: 'shared',
      visibility: 'platform',
      name: 'Platform',
    });

    const userACreatedEnv = createEnvData({
      createdBy: userA,
      name: 'Created by A',
    });

    const memberEnv = createEnvData({
      createdBy: 'user-b',
      name: 'Member of',
    });

    registry.register(platformEnv);
    registry.register(userACreatedEnv);
    registry.register(memberEnv);

    // User A joins memberEnv
    const memberCenter = registry.get(memberEnv.id);
    if (memberCenter) {
      memberCenter.addMember(userA, 'member');
    }

    // Act
    const visible = registry.getVisibleEnvironments(userA);

    // Assert
    // Should see: platform + created + member
    expect(visible.length).toBe(3);
    expect(visible.some(e => e.id === platformEnv.id)).toBe(true);
    expect(visible.some(e => e.id === userACreatedEnv.id)).toBe(true);
    expect(visible.some(e => e.id === memberEnv.id)).toBe(true);

    logger.info('✅ Test passed: aggregate all visible environment types');
  });
});
