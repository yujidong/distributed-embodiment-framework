/**
 * Member Manager Module
 *
 * Extracted from EnvironmentCenter for Single Responsibility Principle.
 * Handles member registration, role management, and permission checking.
 */

import type { EventManager } from '../../events/EventManager.js';
import { EventPriority, EventType } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Member role types
 */
const logger = createLogger('MemberManager');

export enum MemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
  GUEST = 'guest',
}

/**
 * Member status
 */
export enum MemberStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  PENDING = 'pending',
}

/**
 * Environment member
 */
export interface EnvironmentMember {
  userId: string;
  userName?: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: Date;
  lastActiveAt?: Date;
  permissions: string[];
  metadata?: Record<string, any>;
}

/**
 * Role permissions mapping
 */
export const ROLE_PERMISSIONS: Record<MemberRole, string[]> = {
  [MemberRole.OWNER]: [
    'manage_members',
    'manage_devices',
    'manage_agents',
    'manage_services',
    'manage_environment',
    'view_all',
    'edit_all',
    'delete_all',
    'manage_collaborations',
    'configure_settings',
  ],
  [MemberRole.ADMIN]: [
    'manage_devices',
    'manage_agents',
    'manage_services',
    'view_all',
    'edit_all',
    'manage_collaborations',
  ],
  [MemberRole.MEMBER]: [
    'view_devices',
    'view_agents',
    'view_services',
    'participate_collaborations',
    'use_services',
  ],
  [MemberRole.VIEWER]: [
    'view_devices',
    'view_agents',
    'view_services',
    'view_collaborations',
  ],
  [MemberRole.GUEST]: [
    'view_public',
  ],
};

/**
 * Member Manager - Handles member and role management
 *
 * This class was extracted from EnvironmentCenter to follow Single Responsibility Principle.
 * It handles:
 * - Member registration and removal
 * - Role assignment and permission checking
 * - Member status tracking
 */
export class MemberManager {
  private members: Map<string, EnvironmentMember> = new Map();
  private ownerUserId: string;

  constructor(
    private readonly environmentId: string,
    private readonly eventManager: EventManager,
    ownerUserId: string
  ) {
    this.ownerUserId = ownerUserId;
    // Auto-add owner as first member
    this.addMember(ownerUserId, MemberRole.OWNER);
  }

  /**
   * Add a member to the environment
   */
  addMember(
    userId: string,
    role: MemberRole | MemberRole.MEMBER,
    metadata?: Record<string, any>
  ): EnvironmentMember {
    if (this.members.has(userId)) {
      logger.warn(`User ${userId} is already a member`);
      return this.members.get(userId)!;
    }

    const member: EnvironmentMember = {
      userId,
      role,
      status: MemberStatus.ACTIVE,
      joinedAt: new Date(),
      permissions: ROLE_PERMISSIONS[role] || [],
      metadata,
    };
    this.members.set(userId, member);
    logger.info(`Added member ${userId} with role ${role}`);
    // Emit event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: this.environmentId,
      payload: {
        memberAction: 'MEMBER_JOINED',
        environmentId: this.environmentId,
        userId,
        role,
        timestamp: new Date(),
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });
    return member;
  }

  /**
   * Remove a member from the environment
   */
  removeMember(userId: string): boolean {
    // Cannot remove owner
    if (userId === this.ownerUserId) {
      logger.warn(`Cannot remove owner ${userId}`);
      return false;
    }

    const member = this.members.get(userId);
    if (!member) {
      logger.warn(`User ${userId} is not a member`);
      return false;
    }

    this.members.delete(userId);

    logger.info(`Removed member ${userId}`);

    // Emit event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: this.environmentId,
      payload: {
        memberAction: 'MEMBER_LEFT',
        environmentId: this.environmentId,
        userId,
        previousRole: member.role,
        timestamp: new Date(),
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    return true;
  }

  /**
   * Get a member by user ID
   */
  getMember(userId: string): EnvironmentMember | undefined {
    return this.members.get(userId);
  }

  /**
   * Get all members
   */
  getAllMembers(): EnvironmentMember[] {
    return Array.from(this.members.values());
  }

  /**
   * List all members (alias for getAllMembers)
   */
  listMembers(): EnvironmentMember[] {
    return this.getAllMembers();
  }

  /**
   * Get members by role
   */
  getMembersByRole(role: MemberRole): EnvironmentMember[] {
    return this.getAllMembers().filter((m) => m.role === role);
  }

  /**
   * Get members by status
   */
  getMembersByStatus(status: MemberStatus): EnvironmentMember[] {
    return this.getAllMembers().filter((m) => m.status === status);
  }

  /**
   * Update member role
   */
  updateMemberRole(userId: string, newRole: MemberRole): boolean {
    // Cannot change owner's role
    if (userId === this.ownerUserId) {
      logger.warn(`Cannot change owner's role`);
      return false;
    }

    const member = this.members.get(userId);
    if (!member) {
      logger.warn(`User ${userId} is not a member`);
      return false;
    }

    const previousRole = member.role;
    member.role = newRole;
    member.permissions = ROLE_PERMISSIONS[newRole] || [];
    member.lastActiveAt = new Date();

    logger.info(`Updated role for ${userId}: ${previousRole} -> ${newRole}`);

    // Emit event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: this.environmentId,
      payload: {
        memberAction: 'MEMBER_ROLE_CHANGED',
        environmentId: this.environmentId,
        userId,
        previousRole,
        newRole,
        timestamp: new Date(),
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    return true;
  }

  /**
   * Update member status
   */
  updateMemberStatus(userId: string, status: MemberStatus): boolean {
    const member = this.members.get(userId);
    if (!member) {
      logger.warn(`User ${userId} is not a member`);
      return false;
    }

    member.status = status;
    member.lastActiveAt = new Date();

    logger.info(`Updated status for ${userId}: ${status}`);

    return true;
  }

  /**
   * Check if user has permission
   */
  hasPermission(userId: string, permission: string): boolean {
    const member = this.members.get(userId);
    if (!member) {
      return false;
    }

    // Check if member is active
    if (member.status !== MemberStatus.ACTIVE) {
      return false;
    }

    return member.permissions.includes(permission);
  }

  /**
   * Check if user is a member
   */
  isMember(userId: string): boolean {
    return this.members.has(userId);
  }

  /**
   * Check if user is owner
   */
  isOwner(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  /**
   * Check if user is admin or higher
   */
  isAdminOrHigher(userId: string): boolean {
    const member = this.members.get(userId);
    if (!member) {
      return false;
    }

    return (
      member.role === MemberRole.OWNER ||
      member.role === MemberRole.ADMIN
    );
  }

  /**
   * Get member count
   */
  getMemberCount(): number {
    return this.members.size;
  }

  /**
   * Get active member count
   */
  getActiveMemberCount(): number {
    return this.getMembersByStatus(MemberStatus.ACTIVE).length;
  }

  /**
   * Update member last active time
   */
  updateLastActive(userId: string): void {
    const member = this.members.get(userId);
    if (member) {
      member.lastActiveAt = new Date();
    }
  }

  /**
   * Clear all members except owner
   */
  clearAllMembers(): void {
    const owner = this.members.get(this.ownerUserId);
    this.members.clear();
    if (owner) {
      this.members.set(this.ownerUserId, owner);
    }
    logger.info(`Cleared all members except owner`);
  }

  /**
   * Get member statistics
   */
  getStats(): {
    total: number;
    active: number;
    inactive: number;
    byRole: Record<MemberRole, number>;
  } {
    const stats = {
      total: this.members.size,
      active: 0,
      inactive: 0,
      byRole: {} as Record<MemberRole, number>,
    };

    // Initialize role counts
    for (const role of Object.values(MemberRole)) {
      stats.byRole[role] = 0;
    }

    for (const member of this.members.values()) {
      if (member.status === MemberStatus.ACTIVE) {
        stats.active++;
      } else {
        stats.inactive++;
      }
      stats.byRole[member.role]++;
    }

    return stats;
  }
}
