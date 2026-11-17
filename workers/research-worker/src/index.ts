/**
 * @genie/worker-research
 *
 * 調べ物だけを拾う worker。正本 §26。
 *
 * 分けるのは、**一つの重い仕事が別の仕事を止めない**ため。
 * 長い動画の書き出しと数秒の調べ物が同じ列に並ぶと、後者が待たされる。
 *
 * 起動そのものは `@genie/worker-task` の組み立てを使い、
 * ここは「どの列を見るか」と「どの executor を持つか」だけを決める。
 */
import { TASK_QUEUES } from '@genie/service-task';

export const RESEARCH_QUEUE = TASK_QUEUES.research;

/** この worker が引き受ける tool。ここに無いものは拾わない。 */
export const RESEARCH_TOOLS = [
  'research.plan',
  'research.search',
  'research.deepen',
  'research.verify',
  'research.report',
] as const;
