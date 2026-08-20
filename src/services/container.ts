import { resolve } from 'node:path';
import { KaneAdapter } from '../adapters/kane-adapter.js';
import { TargetObserver } from '../adapters/target-observer.js';
import { FileStore } from '../store/file-store.js';
import { AuditService } from './audit-service.js';
import { KaneTestService } from './test-generator.js';
import { ReadmeSourceService } from './readme-source.js';
import { ReceiptService } from './receipt-service.js';

export interface ProbatContainer {
  workspaceRoot: string;
  store: FileStore;
  auditService: AuditService;
}

export function createContainer(workspaceRoot = process.cwd()): ProbatContainer {
  const root = resolve(workspaceRoot);
  const store = new FileStore(root);
  const readmes = new ReadmeSourceService(root);
  const tests = new KaneTestService(root);
  const kane = new KaneAdapter();
  const targets = new TargetObserver();
  const receipts = new ReceiptService();
  const auditService = new AuditService(root, store, readmes, tests, kane, targets, receipts);
  return { workspaceRoot: root, store, auditService };
}
