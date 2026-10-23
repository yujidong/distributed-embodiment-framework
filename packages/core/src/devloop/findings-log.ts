/**
 * FindingsLog — persistent storage for the dev loop's entire history.
 * Writes JSONL for findings (machine-readable) and Markdown for the
 * human-readable log, lessons, and final report.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding, DevPlan, TaskResult, LoopState } from './types.js';

export class FindingsLog {
  private readonly baseDir: string;

  constructor(baseDir: string = 'data/devloop') {
    this.baseDir = baseDir;
    fs.mkdirSync(path.join(baseDir, 'plans'), { recursive: true });
  }

  // ------------------------------------------------------------------ findings

  appendFinding(finding: Finding): void {
    const line = JSON.stringify(finding) + '\n';
    fs.appendFileSync(path.join(this.baseDir, 'findings.jsonl'), line, 'utf-8');
  }

  loadFindings(): Finding[] {
    const file = path.join(this.baseDir, 'findings.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Finding);
  }

  // ------------------------------------------------------------------ plans

  savePlan(plan: DevPlan): void {
    const file = path.join(this.baseDir, 'plans', `${plan.id}.json`);
    fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf-8');
  }

  loadPlans(): DevPlan[] {
    const dir = path.join(this.baseDir, 'plans');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as DevPlan)
      .sort((a, b) => a.iterationNumber - b.iterationNumber);
  }

  // ------------------------------------------------------------------ log.md

  appendLog(entry: string): void {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      path.join(this.baseDir, 'log.md'),
      `\n## ${timestamp}\n\n${entry}\n`,
      'utf-8',
    );
  }

  // ------------------------------------------------------------------ lessons

  appendLesson(lesson: string): void {
    fs.appendFileSync(
      path.join(this.baseDir, 'lessons.md'),
      `- ${lesson}\n`,
      'utf-8',
    );
  }

  // ------------------------------------------------------------------ report

  writeReport(state: LoopState, findings: Finding[], plans: DevPlan[], results: TaskResult[]): void {
    const lines: string[] = [
      '# DevLoop 最终报告',
      '',
      `**状态**: ${state.phase}`,
      `**迭代次数**: ${state.iteration}`,
      `**开始时间**: ${state.startedAt}`,
      `**总发现数**: ${findings.length}`,
      `**已解决**: ${findings.filter(f => f.severity !== 'low').length - findings.filter(f => f.category === 'bug' && f.satisfactionScore === 5).length}`,
      '',
      '## 满意度趋势',
      '',
      ...state.satisfactionTrend.map((s, i) => `第 ${i + 1} 轮: ${'★'.repeat(s)}${'☆'.repeat(5 - s)} (${s}/5)`),
      '',
      '## 发现汇总',
      '',
      '| 类别 | 数量 |',
      '|------|------|',
    ];

    const categories = ['bug', 'limitation', 'confusion', 'success', 'idea'] as const;
    for (const cat of categories) {
      const count = findings.filter(f => f.category === cat).length;
      if (count > 0) lines.push(`| ${cat} | ${count} |`);
    }

    lines.push('', '## 开发计划执行', '');
    for (const plan of plans) {
      lines.push(`### 第 ${plan.iterationNumber} 轮 (${plan.id})`);
      lines.push('', plan.summary, '');
      for (const task of plan.tasks) {
        const icon = task.status === 'done' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'needs_human' ? '⚠️' : '⏳';
        lines.push(`- ${icon} ${task.title} [${task.status}]`);
        if (task.result) lines.push(`  > ${task.result}`);
      }
      lines.push('');
    }

    lines.push('## 经验教训', '');
    const lessonsFile = path.join(this.baseDir, 'lessons.md');
    if (fs.existsSync(lessonsFile)) {
      lines.push(fs.readFileSync(lessonsFile, 'utf-8'));
    }

    fs.writeFileSync(path.join(this.baseDir, 'report.md'), lines.join('\n'), 'utf-8');
  }
}
