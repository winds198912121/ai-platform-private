/** 执行进度与人工批准分开计算；失败保留最后已到达的节点，重试从零开始。 */
export function progressOf(item) {
  if (['approved', 'awaiting_review'].includes(item.status)) return 100;
  if (['pending', 'rejected'].includes(item.status)) return 0;
  const value = Number(item.progress);
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : 0;
}

export function stageExecution(project, stage) {
  const modules = project.modules || [];
  if (stage.kind !== 'development' || !modules.length || ['pending', 'rejected', 'approved'].includes(stage.status)) return stage;
  return {
    ...stage,
    status: modules.some(m => m.status === 'running') ? 'running' : stage.status,
    progress: Math.round(modules.reduce((sum, m) => sum + progressOf(m), 0) / modules.length),
    progress_label: 'modules',
    completed: modules.filter(m => ['approved', 'awaiting_review'].includes(m.status)).length,
    total: modules.length,
  };
}
