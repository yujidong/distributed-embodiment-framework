/**
 * Context Validator
 *
 * Validates the three-dimensional context for requirement compliance:
 * 1. Physical Context: Location, time, environmental parameters
 * 2. Task Context: Priority, dependencies, deadlines, history
 * 3. Service Context: QoS requirements, resource constraints, trust
 *
 * Ensures services can operate within the specified context constraints.
 */

import type {
  ValidationContext,
  PhysicalContext,
  RequirementTaskContext,
  RequirementServiceContext
} from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ContextValidator');

/**
 * Context Validator class
 * Validates services against contextual requirements
 */


export class ContextValidator {
  /**
   * Validate a service against the full validation context
   *
   * @param context - The validation context to check
   * @returns Context validation result with any violations
   */
  validateContext(context: ValidationContext): ContextValidationResult {
    logger.info('Starting context validation');

    const startTime = Date.now();
    const violations: ContextViolation[] = [];

    // Validate each dimension
    const physicalViolations = this.validatePhysicalContext(context.physical);
    violations.push(...physicalViolations);

    const taskViolations = this.validateTaskContext(context.task);
    violations.push(...taskViolations);

    const serviceViolations = this.validateServiceContext(context.service);
    violations.push(...serviceViolations);

    // Calculate score
    const score = this.calculateContextScore(violations);

    const validationTime = Date.now() - startTime;

    const result: ContextValidationResult = {
      valid: violations.filter(v => v.severity === 'error').length === 0,
      score,
      violations,
      validationTime,
      dimensions: {
        physical: {
          valid: physicalViolations.filter(v => v.severity === 'error').length === 0,
          score: this.calculateDimensionScore(physicalViolations)
        },
        task: {
          valid: taskViolations.filter(v => v.severity === 'error').length === 0,
          score: this.calculateDimensionScore(taskViolations)
        },
        service: {
          valid: serviceViolations.filter(v => v.severity === 'error').length === 0,
          score: this.calculateDimensionScore(serviceViolations)
        }
      }
    };

    logger.info(`Context validation completed: ${result.valid ? 'VALID' : 'INVALID'} (score: ${score.toFixed(2)})`);

    return result;
  }

  /**
   * Validate physical context
   *
   * @param physical - Physical context requirements
   * @returns Array of physical context violations
   */
  private validatePhysicalContext(physical: PhysicalContext): ContextViolation[] {
    const violations: ContextViolation[] = [];

    // Validate location type
    if (!physical.location.type) {
      violations.push({
        dimension: 'physical',
        aspect: 'location',
        severity: 'error',
        message: 'Location type is not specified',
        requirement: 'valid location type',
        actual: 'undefined'
      });
    }

    // Validate temporal constraints
    const now = new Date();

    if (physical.temporal.validFrom && now < physical.temporal.validFrom) {
      violations.push({
        dimension: 'physical',
        aspect: 'temporal',
        severity: 'error',
        message: 'Current time is before validFrom time',
        requirement: `current time >= ${physical.temporal.validFrom.toISOString()}`,
        actual: now.toISOString()
      });
    }

    if (physical.temporal.validUntil && now > physical.temporal.validUntil) {
      violations.push({
        dimension: 'physical',
        aspect: 'temporal',
        severity: 'error',
        message: 'Current time is after validUntil time',
        requirement: `current time <= ${physical.temporal.validUntil.toISOString()}`,
        actual: now.toISOString()
      });
    }

    // Validate time of day constraints
    if (physical.temporal.timeOfDay) {
      const currentTime = this.getCurrentTimeInTimezone(physical.temporal.timezone);

      if (physical.temporal.timeOfDay.start && currentTime < physical.temporal.timeOfDay.start) {
        violations.push({
          dimension: 'physical',
          aspect: 'temporal',
          severity: 'warning',
          message: 'Current time is before allowed time range',
          requirement: `time >= ${physical.temporal.timeOfDay.start}`,
          actual: currentTime
        });
      }

      if (physical.temporal.timeOfDay.end && currentTime > physical.temporal.timeOfDay.end) {
        violations.push({
          dimension: 'physical',
          aspect: 'temporal',
          severity: 'warning',
          message: 'Current time is after allowed time range',
          requirement: `time <= ${physical.temporal.timeOfDay.end}`,
          actual: currentTime
        });
      }
    }

    // Validate environmental constraints (if current environment data available)
    // This would require integration with environment monitoring
    // For now, we just check if constraints are defined
    if (physical.environmental.temperature && !this.isValidRange(physical.environmental.temperature)) {
      violations.push({
        dimension: 'physical',
        aspect: 'environmental',
        severity: 'warning',
        message: 'Temperature range is invalid',
        requirement: 'min < max',
        actual: `min: ${physical.environmental.temperature.min}, max: ${physical.environmental.temperature.max}`
      });
    }

    if (physical.environmental.humidity && !this.isValidRange(physical.environmental.humidity)) {
      violations.push({
        dimension: 'physical',
        aspect: 'environmental',
        severity: 'warning',
        message: 'Humidity range is invalid',
        requirement: 'min < max',
        actual: `min: ${physical.environmental.humidity.min}, max: ${physical.environmental.humidity.max}`
      });
    }

    return violations;
  }

  /**
   * Validate task context
   *
   * @param task - Task context requirements
   * @returns Array of task context violations
   */
  private validateTaskContext(task: RequirementTaskContext): ContextViolation[] {
    const violations: ContextViolation[] = [];

    // Validate task ID
    if (!task.taskId) {
      violations.push({
        dimension: 'task',
        aspect: 'taskId',
        severity: 'error',
        message: 'Task ID is not specified',
        requirement: 'valid task ID',
        actual: 'undefined'
      });
    }

    // Validate deadline constraints
    const now = new Date();

    if (task.deadline) {
      if (now > task.deadline.hardDeadline) {
        violations.push({
          dimension: 'task',
          aspect: 'deadline',
          severity: 'error',
          message: 'Hard deadline has passed',
          requirement: `current time <= ${task.deadline.hardDeadline.toISOString()}`,
          actual: now.toISOString()
        });
      } else if (task.deadline.softDeadline && now > task.deadline.softDeadline) {
        violations.push({
          dimension: 'task',
          aspect: 'deadline',
          severity: 'warning',
          message: 'Soft deadline has passed',
          requirement: `current time <= ${task.deadline.softDeadline.toISOString()}`,
          actual: now.toISOString()
        });
      }
    }

    // Validate priority and urgency alignment
    if (task.priority === 'low' && task.urgency === 'immediate') {
      violations.push({
        dimension: 'task',
        aspect: 'priority',
        severity: 'warning',
        message: 'Priority and urgency are mismatched',
        requirement: 'priority and urgency should align',
        actual: `priority: ${task.priority}, urgency: ${task.urgency}`
      });
    }

    // Validate dependencies
    if (task.dependencies.taskIds.length > 0 && task.dependencies.order === 'parallel') {
      violations.push({
        dimension: 'task',
        aspect: 'dependencies',
        severity: 'info',
        message: 'Parallel execution with task dependencies may cause issues',
        requirement: 'sequential execution recommended for dependent tasks',
        actual: 'parallel execution'
      });
    }

    // Validate execution history
    if (task.history.previousExecutions && task.history.previousExecutions > 0) {
      if (task.history.successRate !== undefined && task.history.successRate < 0.5) {
        violations.push({
          dimension: 'task',
          aspect: 'history',
          severity: 'warning',
          message: 'Task has low success rate',
          requirement: 'success rate >= 0.5',
          actual: task.history.successRate.toString()
        });
      }
    }

    return violations;
  }

  /**
   * Validate service context
   *
   * @param service - Service context requirements
   * @returns Array of service context violations
   */
  private validateServiceContext(service: RequirementServiceContext): ContextViolation[] {
    const violations: ContextViolation[] = [];

    // Validate available services
    if (!service.availableServices || service.availableServices.length === 0) {
      violations.push({
        dimension: 'service',
        aspect: 'availability',
        severity: 'error',
        message: 'No services available',
        requirement: 'at least 1 available service',
        actual: '0 services'
      });
      return violations;
    }

    // Check service health
    const unhealthyServices = service.availableServices.filter(s => s.healthStatus === 'unhealthy');
    if (unhealthyServices.length > 0) {
      violations.push({
        dimension: 'service',
        aspect: 'health',
        severity: 'warning',
        message: `${unhealthyServices.length} service(s) are unhealthy`,
        requirement: 'all services should be healthy',
        actual: `${unhealthyServices.length} unhealthy services`
      });
    }

    // Validate QoS requirements against available services
    for (const svc of service.availableServices) {
      // Check availability requirement
      if (service.qosRequirements.minAvailability && svc.availability < service.qosRequirements.minAvailability) {
        violations.push({
          dimension: 'service',
          aspect: 'qos',
          severity: 'error',
          message: `Service ${svc.serviceId} does not meet availability requirement`,
          requirement: `availability >= ${service.qosRequirements.minAvailability}`,
          actual: svc.availability.toString()
        });
      }

      // Check load constraints
      if (svc.currentLoad > 0.9) {
        violations.push({
          dimension: 'service',
          aspect: 'load',
          severity: 'warning',
          message: `Service ${svc.serviceId} is under high load`,
          requirement: 'current load < 0.9',
          actual: svc.currentLoad.toString()
        });
      }

      // Check cost constraints
      if (service.qosRequirements.maxCost && svc.cost.monetary !== undefined && svc.cost.monetary > service.qosRequirements.maxCost) {
        violations.push({
          dimension: 'service',
          aspect: 'cost',
          severity: 'error',
          message: `Service ${svc.serviceId} exceeds maximum cost`,
          requirement: `cost <= ${service.qosRequirements.maxCost}`,
          actual: svc.cost.monetary.toString()
        });
      }
    }

    // Validate resource constraints
    if (service.resourceConstraints.maxConcurrentUses) {
      const maxUses = service.resourceConstraints.maxConcurrentUses;
      const highLoadServices = service.availableServices.filter(
        s => s.currentLoad * maxUses >= maxUses
      );

      if (highLoadServices.length > 0) {
        violations.push({
          dimension: 'service',
          aspect: 'resources',
          severity: 'warning',
          message: 'Some services may have reached concurrent use limit',
          requirement: `concurrent uses < ${service.resourceConstraints.maxConcurrentUses}`,
          actual: `${highLoadServices.length} services at limit`
        });
      }
    }

    // Validate trust context
    if (service.trustContext.minReputation) {
      const lowReputationServices = service.availableServices.filter(s => {
        const collaboration = service.trustContext.previousCollaborations?.find(c => c.providerId === s.providerId);
        return collaboration && collaboration.averageQuality < service.trustContext.minReputation!;
      });

      if (lowReputationServices.length > 0) {
        violations.push({
          dimension: 'service',
          aspect: 'trust',
          severity: 'warning',
          message: `${lowReputationServices.length} service(s) have below minimum reputation`,
          requirement: `reputation >= ${service.trustContext.minReputation}`,
          actual: `${lowReputationServices.length} services below threshold`
        });
      }
    }

    return violations;
  }

  /**
   * Calculate overall context score from violations
   *
   * @param violations - Array of all violations
   * @returns Score between 0 and 1
   */
  private calculateContextScore(violations: ContextViolation[]): number {
    if (violations.length === 0) {
      return 1.0;
    }

    const errorCount = violations.filter(v => v.severity === 'error').length;
    const warningCount = violations.filter(v => v.severity === 'warning').length;
    const infoCount = violations.filter(v => v.severity === 'info').length;

    // Weight violations by severity
    let penalty = 0;
    penalty += errorCount * 1.0;
    penalty += warningCount * 0.3;
    penalty += infoCount * 0.1;

    return Math.max(0, 1.0 - penalty);
  }

  /**
   * Calculate score for a single dimension
   *
   * @param violations - Violations for a dimension
   * @returns Score between 0 and 1
   */
  private calculateDimensionScore(violations: ContextViolation[]): number {
    if (violations.length === 0) {
      return 1.0;
    }

    const errorCount = violations.filter(v => v.severity === 'error').length;
    const warningCount = violations.filter(v => v.severity === 'warning').length;

    return Math.max(0, 1.0 - (errorCount * 0.5 + warningCount * 0.2));
  }

  /**
   * Get current time in specified timezone
   *
   * @param timezone - IANA timezone string
   * @returns Current time in HH:MM format
   */
  private getCurrentTimeInTimezone(timezone?: string): string {
    const now = new Date();
    if (timezone) {
      return now.toLocaleTimeString('en-US', {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    return now.toTimeString().slice(0, 5);
  }

  /**
   * Validate if a range is valid (min < max)
   *
   * @param range - Range object with min and max
   * @returns True if range is valid
   */
  private isValidRange(range: { min: number; max: number }): boolean {
    return range.min < range.max;
  }
}

/**
 * Context validation result
 */
export interface ContextValidationResult {
  valid: boolean;
  score: number;
  violations: ContextViolation[];
  validationTime: number;
  dimensions: {
    physical: DimensionValidationResult;
    task: DimensionValidationResult;
    service: DimensionValidationResult;
  };
}

/**
 * Dimension validation result
 */
export interface DimensionValidationResult {
  valid: boolean;
  score: number;
}

/**
 * Context violation
 */
export interface ContextViolation {
  dimension: 'physical' | 'task' | 'service';
  aspect: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  requirement: string;
  actual: string;
}
