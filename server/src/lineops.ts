import { PoolClient } from 'pg';
import {
  AdjustedLineView,
  DocumentRow,
  FragmentMoveView,
  FragmentRow,
  LineAdjustGroupView,
  LineRow,
  MergePreview,
  SplitPreview,
} from './types';
import { charLen, HttpError, sliceCp } from './util';

/**
 * 行界调整：在不改变字序的前提下调整一份抄本的原始行界。
 *  - 拆分：按 Unicode 码点把一行拆成相邻两行（左半留在原行，右半成为新行，后续行号 +1）；
 *  - 合并：把相邻两行并为一行（右行文字接到左行末尾，右行删除，后续行号 -1）。
 *
 * 片段迁移规则（预览与提交共用同一套纯函数，保证一致）：
 *  - 未跨拆分点的片段随文字迁移并重算区间（拆分左半不动、右半迁至新行并左移；
 *    合并时左行不动、右行迁至左行并右移左行字数）；
 *  - 跨拆分点的片段保留原定位（可追溯），所在组标为待修复；
 *    其落在另一行的文字不作为该片段的确定文字（读模型按越界处理，仅存可见部分供参考）；
 *  - 原已待修复的组只增不减：行界调整绝不把待修复组自动转为完好；
 *  - 缺文标记不带行引用，行界调整不影响。
 */

export interface LineCtx {
  id: number;
  ms_id: number;
  line_no: number;
  content: string;
  doc_id: number;
  ms_name: string;
}

const LINE_CTX_SQL = `
  SELECT l.id, l.ms_id, l.line_no, l.content, m.doc_id, m.name AS ms_name
  FROM lines l JOIN manuscripts m ON m.id = l.ms_id`;

/** 取行及其抄本/文献归属；不存在 → 404。 */
export async function getLineCtx(client: PoolClient, lineId: number): Promise<LineCtx> {
  const { rows } = await client.query<LineCtx>(`${LINE_CTX_SQL} WHERE l.id=$1`, [lineId]);
  if (rows.length === 0) throw new HttpError(404, `行 #${lineId} 不存在`);
  return rows[0];
}

/** 同上，但加行锁（提交用）。 */
export async function lockLineCtx(client: PoolClient, lineId: number): Promise<LineCtx> {
  const { rows } = await client.query<LineCtx>(`${LINE_CTX_SQL} WHERE l.id=$1 FOR UPDATE OF l`, [lineId]);
  if (rows.length === 0) throw new HttpError(404, `行 #${lineId} 不存在`);
  return rows[0];
}

export interface FragWithGroup extends FragmentRow {
  ord: number;
  gbroken: boolean;
}

/** 取若干行上的全部真实片段（缺文标记不带行引用，天然不受影响），附所属组信息。 */
export async function loadFragsOnLines(
  client: PoolClient,
  lineIds: number[],
  forUpdate = false
): Promise<FragWithGroup[]> {
  if (lineIds.length === 0) return [];
  const { rows } = await client.query<FragWithGroup>(
    `SELECT f.id, f.group_id, f.doc_id, f.ms_id, f.line_id, f.start_cp, f.end_cp, f.missing,
            g.ord, g.broken AS gbroken
     FROM fragments f JOIN grp g ON g.id = f.group_id
     WHERE f.line_id = ANY($1::bigint[]) AND f.missing = FALSE
     ORDER BY f.id ${forUpdate ? 'FOR UPDATE OF f' : ''}`,
    [lineIds]
  );
  return rows;
}

type MoveKind = 'unchanged' | 'moved' | 'crossing';

interface Classified {
  f: FragWithGroup;
  kind: MoveKind;
  /** 调整后的码点区间（unchanged/crossing 与原相同）。 */
  ns: number;
  ne: number;
}

export interface SplitPlan {
  line: LineCtx;
  splitCp: number;
  leftContent: string;
  rightContent: string;
  msLines: LineRow[];
  classified: Classified[];
}

export interface MergePlan {
  left: LineCtx;
  right: LineCtx;
  mergedContent: string;
  msLines: LineRow[];
  classified: Classified[];
}

/** 拆分计划：校验拆分点合法（行内码点，1..len-1），并对该行全部真实片段分类。 */
export function planSplit(
  line: LineCtx,
  splitCp: number,
  msLines: LineRow[],
  frags: FragWithGroup[]
): SplitPlan {
  const len = charLen(line.content);
  if (len < 2) {
    throw new HttpError(400, `第 ${line.line_no} 行共 ${len} 字，不足两字，无法拆分（拆分后两行均须非空）`, {
      lineNo: line.line_no,
      lineLength: len,
    });
  }
  if (!Number.isInteger(splitCp) || splitCp < 1 || splitCp > len - 1) {
    throw new HttpError(
      400,
      `拆分点非法：第 ${line.line_no} 行共 ${len} 字，拆分点须为 1–${len - 1} 之间的码点位置` +
        `（收到 ${splitCp}；行首 0 与行尾 ${len} 不可拆分）`,
      { lineNo: line.line_no, lineLength: len, splitCp }
    );
  }
  const classified: Classified[] = frags.map((f) => {
    const s = f.start_cp as number;
    const e = f.end_cp as number;
    if (e <= splitCp) return { f, kind: 'unchanged', ns: s, ne: e }; // 全在左半：保持原样
    if (s >= splitCp) return { f, kind: 'moved', ns: s - splitCp, ne: e - splitCp }; // 全在右半：迁至新行
    return { f, kind: 'crossing', ns: s, ne: e }; // 跨拆分点：保留原定位，待修复
  });
  return {
    line,
    splitCp,
    leftContent: sliceCp(line.content, 0, splitCp),
    rightContent: sliceCp(line.content, splitCp, len),
    msLines,
    classified,
  };
}

/** 合并计划：校验两行属于同一抄本且相邻（右行 = 左行 + 1），右行片段迁至左行。 */
export function planMerge(
  left: LineCtx,
  right: LineCtx,
  msLines: LineRow[],
  frags: FragWithGroup[]
): MergePlan {
  if (left.id === right.id) {
    throw new HttpError(400, '合并需要两个不同的相邻行（左行与右行不能是同一行）');
  }
  if (left.ms_id !== right.ms_id) {
    throw new HttpError(
      400,
      `行 #${left.id}（抄本「${left.ms_name}」）与行 #${right.id}（抄本「${right.ms_name}」）` +
        `不属于同一抄本，不能合并`,
      { leftLineId: left.id, rightLineId: right.id }
    );
  }
  if (right.line_no !== left.line_no + 1) {
    throw new HttpError(
      400,
      `非相邻行不能合并：第 ${left.line_no} 行与第 ${right.line_no} 行不相邻` +
        `（仅可合并同一抄本内行号相邻的两行，右行行号须为左行 +1）`,
      { leftLineNo: left.line_no, rightLineNo: right.line_no }
    );
  }
  const shift = charLen(left.content);
  const classified: Classified[] = frags.map((f) => {
    const s = f.start_cp as number;
    const e = f.end_cp as number;
    if (f.line_id === right.id) return { f, kind: 'moved', ns: s + shift, ne: e + shift }; // 右行 → 迁至左行
    return { f, kind: 'unchanged', ns: s, ne: e }; // 左行：保持原样
  });
  return { left, right, mergedContent: left.content + right.content, msLines, classified };
}

// ---------- 预览组装 ----------

function groupViews(classified: Classified[], op: 'split' | 'merge'): LineAdjustGroupView[] {
  const byGroup = new Map<number, { ord: number; brokenBefore: boolean; brokenAfter: boolean; kinds: Set<MoveKind> }>();
  for (const c of classified) {
    const cur =
      byGroup.get(c.f.group_id) ??
      { ord: c.f.ord, brokenBefore: c.f.gbroken, brokenAfter: c.f.gbroken, kinds: new Set<MoveKind>() };
    cur.kinds.add(c.kind);
    if (c.kind === 'crossing') cur.brokenAfter = true; // 只增不减：待修复绝不自动转完好
    byGroup.set(c.f.group_id, cur);
  }
  return [...byGroup.entries()]
    .map(([groupId, g]) => {
      let reason: string;
      if (g.kinds.has('crossing')) {
        reason = g.brokenBefore
          ? '片段跨越拆分点：保留原定位，仍为待修复'
          : '片段跨越拆分点：保留原定位并标为待修复，新行文字不作为其确定文字';
      } else if (g.brokenBefore) {
        reason = '原已待修复：行界调整不自动转为完好，片段随文字迁移';
      } else if (g.kinds.has('moved')) {
        reason = op === 'split' ? '片段随右半文字迁至新行，区间已重算，保持完好' : '右行片段迁至左行，区间已重算，保持完好';
      } else {
        reason = op === 'split' ? '未跨拆分点，保持完好' : '位于左行，保持完好';
      }
      return { groupId, ord: g.ord, brokenBefore: g.brokenBefore, brokenAfter: g.brokenAfter, reason };
    })
    .sort((a, b) => a.ord - b.ord);
}

function moveViews(
  classified: Classified[],
  beforeLineNoOf: (f: FragWithGroup) => number,
  afterOf: (c: Classified) => { lineId: number | null; lineNo: number }
): FragmentMoveView[] {
  return classified.map((c) => {
    const at = afterOf(c);
    return {
      fragmentId: c.f.id,
      groupId: c.f.group_id,
      groupOrd: c.f.ord,
      msId: c.f.ms_id,
      status: c.kind,
      before: {
        lineId: c.f.line_id as number,
        lineNo: beforeLineNoOf(c.f),
        startCp: c.f.start_cp as number,
        endCp: c.f.end_cp as number,
      },
      after: { lineId: at.lineId, lineNo: at.lineNo, startCp: c.ns, endCp: c.ne },
      groupBrokenBefore: c.f.gbroken,
      groupBrokenAfter: c.f.gbroken || c.kind === 'crossing',
    };
  });
}

export function buildSplitPreview(
  plan: SplitPlan,
  doc: DocumentRow
): SplitPreview {
  const n = plan.line.line_no;
  const lines: AdjustedLineView[] = [];
  for (const l of [...plan.msLines].sort((a, b) => a.line_no - b.line_no)) {
    if (l.id === plan.line.id) {
      lines.push({ lineId: l.id, lineNo: n, content: plan.leftContent });
      lines.push({ lineId: null, lineNo: n + 1, content: plan.rightContent, isNew: true });
    } else if (l.line_no > n) {
      lines.push({ lineId: l.id, lineNo: l.line_no + 1, content: l.content });
    } else {
      lines.push({ lineId: l.id, lineNo: l.line_no, content: l.content });
    }
  }
  const fragments = moveViews(
    plan.classified,
    () => n,
    (c) => (c.kind === 'moved' ? { lineId: null, lineNo: n + 1 } : { lineId: plan.line.id, lineNo: n })
  );
  const groups = groupViews(plan.classified, 'split');
  return {
    op: 'split',
    documentId: doc.id,
    version: doc.version,
    msId: plan.line.ms_id,
    msName: plan.line.ms_name,
    split: {
      lineId: plan.line.id,
      lineNo: n,
      splitCp: plan.splitCp,
      oldContent: plan.line.content,
      leftContent: plan.leftContent,
      rightContent: plan.rightContent,
      newLineNo: n + 1,
    },
    lines,
    fragments,
    groups,
    willBreakCount: groups.filter((g) => !g.brokenBefore && g.brokenAfter).length,
  };
}

export function buildMergePreview(plan: MergePlan, doc: DocumentRow): MergePreview {
  const n = plan.left.line_no;
  const lines: AdjustedLineView[] = [];
  for (const l of [...plan.msLines].sort((a, b) => a.line_no - b.line_no)) {
    if (l.id === plan.left.id) {
      lines.push({ lineId: l.id, lineNo: n, content: plan.mergedContent });
    } else if (l.id === plan.right.id) {
      continue; // 右行被并入左行后删除
    } else if (l.line_no > plan.right.line_no) {
      lines.push({ lineId: l.id, lineNo: l.line_no - 1, content: l.content });
    } else {
      lines.push({ lineId: l.id, lineNo: l.line_no, content: l.content });
    }
  }
  const lineNoById = new Map(plan.msLines.map((l) => [l.id, l.line_no]));
  const fragments = moveViews(
    plan.classified,
    (f) => lineNoById.get(f.line_id as number) ?? n,
    () => ({ lineId: plan.left.id, lineNo: n })
  );
  const groups = groupViews(plan.classified, 'merge');
  return {
    op: 'merge',
    documentId: doc.id,
    version: doc.version,
    msId: plan.left.ms_id,
    msName: plan.left.ms_name,
    merge: {
      leftLineId: plan.left.id,
      leftLineNo: plan.left.line_no,
      rightLineId: plan.right.id,
      rightLineNo: plan.right.line_no,
      leftContent: plan.left.content,
      rightContent: plan.right.content,
      mergedContent: plan.mergedContent,
    },
    lines,
    fragments,
    groups,
    willBreakCount: 0, // 合并不产生新的待修复组
  };
}

// ---------- 提交落库 ----------

/** 应用拆分：行号后移 → 原行留左半 → 新行接右半 → 片段迁移 → 跨点组标待修复。 */
export async function applySplit(client: PoolClient, plan: SplitPlan): Promise<{ newLineId: number }> {
  const n = plan.line.line_no;
  // 后续行号 +1：按行号降序逐行更新，避免 (ms_id, line_no) 唯一约束冲突
  const shifted = plan.msLines.filter((l) => l.line_no > n).sort((a, b) => b.line_no - a.line_no);
  for (const l of shifted) {
    await client.query('UPDATE lines SET line_no = line_no + 1 WHERE id=$1', [l.id]);
  }
  await client.query('UPDATE lines SET content=$1 WHERE id=$2', [plan.leftContent, plan.line.id]);
  const { rows } = await client.query<{ id: number }>(
    'INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id',
    [plan.line.ms_id, n + 1, plan.rightContent]
  );
  const newLineId = rows[0].id;
  for (const c of plan.classified) {
    if (c.kind !== 'moved') continue;
    await client.query('UPDATE fragments SET line_id=$1, start_cp=$2, end_cp=$3 WHERE id=$4', [
      newLineId,
      c.ns,
      c.ne,
      c.f.id,
    ]);
  }
  const crossingGroups = [...new Set(plan.classified.filter((c) => c.kind === 'crossing').map((c) => c.f.group_id))];
  if (crossingGroups.length > 0) {
    await client.query('UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])', [crossingGroups]);
  }
  return { newLineId };
}

/** 应用合并：左行接右行文字 → 右行片段迁至左行 → 删右行 → 行号前移。待修复状态不变。 */
export async function applyMerge(client: PoolClient, plan: MergePlan): Promise<void> {
  await client.query('UPDATE lines SET content=$1 WHERE id=$2', [plan.mergedContent, plan.left.id]);
  // 先迁移右行片段（删行前必须迁走，否则级联删除）
  for (const c of plan.classified) {
    if (c.kind !== 'moved') continue;
    await client.query('UPDATE fragments SET line_id=$1, start_cp=$2, end_cp=$3 WHERE id=$4', [
      plan.left.id,
      c.ns,
      c.ne,
      c.f.id,
    ]);
  }
  await client.query('DELETE FROM lines WHERE id=$1', [plan.right.id]);
  // 后续行号 -1：按行号升序逐行更新，避免唯一约束冲突
  const shifted = plan.msLines
    .filter((l) => l.line_no > plan.right.line_no)
    .sort((a, b) => a.line_no - b.line_no);
  for (const l of shifted) {
    await client.query('UPDATE lines SET line_no = line_no - 1 WHERE id=$1', [l.id]);
  }
}
