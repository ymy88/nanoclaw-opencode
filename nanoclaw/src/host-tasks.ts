import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from './config.js';
import {
  getHostTasks,
  updateHostTaskRun,
  updateHostTaskNextRun,
} from './db.js';
import { logger } from './logger.js';

const POLL_INTERVAL = 60_000;

export function startHostTaskScheduler(): void {
  logger.info('Host task scheduler started');

  const logsDir = path.join(process.cwd(), 'logs', 'host-tasks');
  fs.mkdirSync(logsDir, { recursive: true });

  setInterval(() => {
    const tasks = getHostTasks();
    const now = new Date();

    for (const task of tasks) {
      if (!task.next_run) {
        try {
          const interval = CronExpressionParser.parse(task.schedule, {
            tz: TIMEZONE,
          });
          const nextRun = interval.next().toISOString();
          updateHostTaskNextRun(task.id, nextRun);
        } catch (err) {
          logger.error(
            { taskId: task.id, schedule: task.schedule, err },
            'Invalid cron expression for host task',
          );
        }
        continue;
      }

      if (new Date(task.next_run) > now) continue;

      logger.info(
        { taskId: task.id, name: task.name },
        'Running host task',
      );

      const args = JSON.parse(task.args) as string[];
      const cwd = task.cwd || process.cwd();
      const logFile = path.join(
        logsDir,
        `${task.id}-${now.toISOString().replace(/[:.]/g, '-')}.log`,
      );

      const env = {
        ...process.env,
        PATH: [
          process.env.PATH,
          '/opt/homebrew/bin',
          '/usr/local/bin',
          `${process.env.HOME}/.local/bin`,
          `${process.env.HOME}/.bun/bin`,
        ].filter(Boolean).join(':'),
      };

      const child = spawn(task.command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        const output = `=== Host Task: ${task.name} ===\nID: ${task.id}\nTime: ${now.toISOString()}\nExit Code: ${code}\n\n=== Stdout ===\n${stdout}\n\n=== Stderr ===\n${stderr}`;
        fs.writeFileSync(logFile, output);

        if (code === 0) {
          logger.info(
            { taskId: task.id, logFile },
            'Host task completed',
          );
        } else {
          logger.error(
            { taskId: task.id, code, logFile },
            'Host task failed',
          );
        }
      });

      child.on('error', (err) => {
        logger.error(
          { taskId: task.id, err },
          'Host task spawn error',
        );
      });

      // Update last_run and calculate next_run
      try {
        const interval = CronExpressionParser.parse(task.schedule, {
          tz: TIMEZONE,
        });
        const nextRun = interval.next().toISOString();
        updateHostTaskRun(task.id, now.toISOString(), nextRun);
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to calculate next run for host task',
        );
      }
    }
  }, POLL_INTERVAL);
}
