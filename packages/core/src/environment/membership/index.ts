/**
 * Membership Module
 *
 * Provides member and role management functionality
 */

export {
  MemberManager,
  MemberRole,
  MemberStatus,
  ROLE_PERMISSIONS,
} from './MemberManager.js';

export type { EnvironmentMember } from './MemberManager.js';

// NOTE: RoleManager was removed - role functionality is in MemberManager
