// 数据库行类型
export interface DocumentRow {
  id: number;
  title: string;
  base_ms_id: number | null;
  version: number;
  published_ver: number;
}

export interface ManuscriptRow {
  id: number;
  doc_id: number;
  name: string;
  position: number;
}

export interface LineRow {
  id: number;
  ms_id: number;
  line_no: number;
  content: string;
}

export interface GroupRow {
  id: number;
  doc_id: number;
  ord: number;
  broken: boolean;
}

export interface FragmentRow {
  id: number;
  group_id: number;
  doc_id: number;
  ms_id: number;
  line_id: number | null;
  start_cp: number | null;
  end_cp: number | null;
  missing: boolean;
}

// ---- 补配：按完好对应组的底本文字，在目标抄本原始行文的空闲区间里预配片段 ----

export type SupplementGroupStatus = 'unique' | 'multiple' | 'none' | 'conflict';

export interface SupplementCandidate {
  lineId: number;
  lineNo: number;
  startCp: number;              // Unicode 码点偏移（左闭）
  endCp: number;                // Unicode 码点偏移（右开）
  text: string;                 // 必与底本文字完整相同
  /** 与其他组候选在同一行区间重叠时，那些组的 id（同组多处候选互不列入）。 */
  conflictsWithGroupIds: number[];
}

export interface SupplementGroup {
  groupId: number;
  ord: number;
  baseText: string;
  /** unique=候选唯一且无冲突（可直接采纳）；multiple=多处；none=无；conflict=唯一但与他组候选重叠。 */
  status: SupplementGroupStatus;
  adoptable: boolean;
  reason: string;
  candidates: SupplementCandidate[];
}

export interface SupplementPreview {
  documentId: number;
  version: number;
  baseMsId: number | null;
  targetMsId: number;
  targetMsName: string;
  /** 纳入补配考虑的完好组数（目标抄本无片段且未标缺文）。 */
  eligibleGroupCount: number;
  /** 未纳入的组数：待修复 / 已有片段 / 已标缺文 / 底本文字不可用。 */
  excludedGroupCount: number;
  groups: SupplementGroup[];
}

export interface SupplementSelectionDTO {
  groupId: number;
  msId: number;
  lineId: number;
  startCp: number;
  endCp: number;
}

export interface EditionRow {
  id: number;
  doc_id: number;
  edition_no: number;
  snapshot: CollationView;
  created_at: string;
}

// ---- 行界调整：在不改变字序的前提下拆分行 / 合并相邻两行 ----

export type LineAdjustOp = 'split' | 'merge';

/** 行界调整后该抄本的一行（预览用；拆分出的新行尚未落库，lineId 为 null）。 */
export interface AdjustedLineView {
  lineId: number | null;
  lineNo: number;
  content: string;
  /** 仅拆分产生的新行为 true。 */
  isNew?: boolean;
}

/** 行界调整中一个受影响片段的去向。 */
export interface FragmentMoveView {
  fragmentId: number;
  groupId: number;
  groupOrd: number;
  msId: number;
  /**
   * unchanged=未跨拆分点（或在合并左行上），保持原样；
   * moved=随文字迁移（拆分右半 / 合并右行）并重算区间；
   * crossing=跨越拆分点：保留原定位可追溯，所在组标为待修复，
   *         另一行文字不作为文字的片段不被承认（越界前可见部分仅供参考）。
   */
  status: 'unchanged' | 'moved' | 'crossing';
  before: { lineId: number; lineNo: number; startCp: number; endCp: number };
  /** 拆分右半新行尚未落库时 lineId 为 null。 */
  after: { lineId: number | null; lineNo: number; startCp: number; endCp: number };
  groupBrokenBefore: boolean;
  groupBrokenAfter: boolean;
}

/** 行界调整波及的对应组（按 ord 升序）。 */
export interface LineAdjustGroupView {
  groupId: number;
  ord: number;
  brokenBefore: boolean;
  brokenAfter: boolean;
  reason: string;
}

export interface SplitPreview {
  op: 'split';
  documentId: number;
  /** 预览时的文献版本号：提交拆分时须作为 expectedVersion 带回。 */
  version: number;
  msId: number;
  msName: string;
  split: {
    lineId: number;
    lineNo: number;
    splitCp: number;
    oldContent: string;
    leftContent: string;
    rightContent: string;
    newLineNo: number;
  };
  /** 调整后该抄本的完整行序。 */
  lines: AdjustedLineView[];
  fragments: FragmentMoveView[];
  groups: LineAdjustGroupView[];
  /** 本次将新变为待修复的组数（跨拆分点片段所在组）。 */
  willBreakCount: number;
}

export interface MergePreview {
  op: 'merge';
  documentId: number;
  version: number;
  msId: number;
  msName: string;
  merge: {
    leftLineId: number;
    leftLineNo: number;
    rightLineId: number;
    rightLineNo: number;
    leftContent: string;
    rightContent: string;
    mergedContent: string;
  };
  lines: AdjustedLineView[];
  fragments: FragmentMoveView[];
  groups: LineAdjustGroupView[];
  /** 合并不产生新的待修复组，恒为 0。 */
  willBreakCount: number;
}

export interface LineAdjustResult {
  ok: boolean;
  op: LineAdjustOp;
  /** 提交后的文献版本号（成功仅推进一次）。 */
  version: number;
  msId: number;
  lineNo: number;
  unchangedFragments: number;
  movedFragments: number;
  crossingFragments: number;
  /** 本次新变为待修复的组（合并恒为空）。 */
  brokenGroups: Array<{ groupId: number; ord: number }>;
  // split
  lineId?: number;
  newLineId?: number;
  newLineNo?: number;
  leftContent?: string;
  rightContent?: string;
  // merge
  removedLineId?: number;
  mergedContent?: string;
}

// ---- 对外（API / 前端）类型 ----

export interface FragmentDTO {
  msId: number;
  missing: boolean;
  lineId?: number | null;
  startCp?: number | null;
  endCp?: number | null;
}

export interface GroupDTO {
  id?: number;
  ord: number;
  fragments: FragmentDTO[];
}

/** 组在某抄本上的呈现片段（读模型，运行时派生）。 */
export interface CellView {
  msId: number;
  missing: boolean;          // 显式缺文
  broken: boolean;           // 原文改动后越界 / 底本已变 → 待修复
  lineNo?: number;
  startCp?: number;
  endCp?: number;
  text?: string;             // 当前原文截取；越界时为越界前可见部分
  oobEnd?: number;           // endCp 超过当前行长时的实际行长
}

export interface GroupView {
  id: number;
  ord: number;
  broken: boolean;
  baseText: string;          // 底本片段文字（底本缺失则为空串）
  inverted: boolean;         // 相对底本顺序的倒置
  cells: CellView[];
  variant: boolean;          // 存在异文
  hasMissing: boolean;       // 存在显式缺文
}

export interface RawLineView {
  lineId: number;
  lineNo: number;
  content: string;
  // 已被有效片段覆盖的码点区间（用于下划线标识），互不重叠
  covered: Array<{ startCp: number; endCp: number; groupId: number; broken: boolean }>;
}

export interface CollationView {
  document: {
    id: number;
    title: string;
    version: number;
    baseMsId: number | null;
    publishedVer: number;
  };
  manuscripts: Array<{ id: number; name: string; position: number; isBase: boolean }>;
  groups: GroupView[];
  /** 各抄本原始行序视图（含未归组文字）。 */
  rawByMs: Array<{ msId: number; lines: RawLineView[] }>;
  stats: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    brokenCount: number;
  };
}

// ---- 版本对照（任一已发布校勘版 vs 当前工作版）----

export interface DiffSideInfo {
  kind: 'edition' | 'working';
  editionNo: number | null;          // 工作版为 null
  version: number;                   // 乐观锁版本号（快照侧为发布当时版本）
  baseMsId: number | null;
  baseMsName: string | null;
  publishedVer: number;
  groupCount: number;
  brokenCount: number;
  createdAt?: string;                // 旧版发布时间
}

export type DiffTokenOp = 'equal' | 'added' | 'removed';

export interface DiffToken {
  op: DiffTokenOp;
  text: string;
}

/** 行文增删改：按抄本 + 该抄本原始行号呈现。 */
export interface LineDiff {
  msId: number;
  msName: string;
  lineNo: number;
  status: 'changed' | 'added' | 'removed';
  oldLineId: number | null;
  newLineId: number | null;
  oldText: string;
  newText: string;
  segments: DiffToken[];             // 码点级 LCS 增删改片段
}

export type CellStateKind = 'absent' | 'missing' | 'fragment';

export interface CellChange {
  msId: number;
  msName: string;
  isBase: boolean;
  oldState: CellStateKind;
  newState: CellStateKind;
  /** 变化项：state=片段有无/缺文切换；location=行号或码点区间；text=确定文字；broken=待修复状态 */
  changes: Array<'state' | 'location' | 'text' | 'broken'>;
  /** 仅当两侧片段均在行内（非越界/失效）时才对确定文字下结论。 */
  textChanged: boolean;
  oldOutOfBounds: boolean;
  newOutOfBounds: boolean;
  oldText: string | null;
  newText: string | null;
  newVisibleText: string | null;
  newOobEnd: number | null;
  oldBroken: boolean;
  newBroken: boolean;
  oldLineNo: number | null;
  newLineNo: number | null;
  oldStartCp: number | null;
  newStartCp: number | null;
  oldEndCp: number | null;
  newEndCp: number | null;
}

export interface PairedGroupDiff {
  status: 'same' | 'changed';
  oldGroupId: number;
  newGroupId: number;
  oldOrd: number;
  newOrd: number;
  ordChanged: boolean;
  oldBroken: boolean;
  newBroken: boolean;
  baseMsId: number;
  /** 两侧唯一对应的底本片段位置（配对依据）。 */
  baseLocation: { lineNo: number; startCp: number; endCp: number };
  cellChanges: CellChange[];
}

export interface UnpairedCell {
  msId: number;
  msName: string;
  isBase: boolean;
  state: CellStateKind;
  broken: boolean;
  /** 片段自身越界 / 引用失效（其文字不得作为确定文字）。 */
  outOfBounds: boolean;
  /** 行内片段的确定文字；越界/失效时为 null。 */
  text: string | null;
  /** 越界前尚可见的文字（不确定，仅供参考）。 */
  visibleText: string | null;
  lineNo: number | null;
  startCp: number | null;
  endCp: number | null;
  oobEnd: number | null;
}

export interface UnpairedGroupDiff {
  side: 'old' | 'new';
  groupId: number;
  ord: number;
  broken: boolean;
  /**
   * 未配对原因：
   * base-differs 两侧底本不同；no-base-location 该侧无可用底本片段位置；
   * duplicate-location 同一底本位置在该侧不唯一；not-matched 另一侧无同位置组。
   */
  reason: 'base-differs' | 'no-base-location' | 'duplicate-location' | 'not-matched';
  baseMsId: number | null;
  baseText: string | null;
  baseLocation: { lineNo: number; startCp: number; endCp: number } | null;
  cells: UnpairedCell[];
}

export interface EditionDiff {
  documentId: number;
  title: string;
  /** 服务端生成时刻：刷新对照即可获得当前最新工作版结果。 */
  generatedAt: string;
  sides: { old: DiffSideInfo; new: DiffSideInfo };
  baseSame: boolean;
  pairingNote: string;
  manuscripts: Array<{
    msId: number;
    name: string;
    inOld: boolean;
    inNew: boolean;
    oldPosition: number | null;
    newPosition: number | null;
    isOldBase: boolean;
    isNewBase: boolean;
  }>;
  textChanges: LineDiff[];
  textChangeCounts: { manuscriptCount: number; changed: number; added: number; removed: number };
  groupDiff: {
    paired: PairedGroupDiff[];
    unpairedOld: UnpairedGroupDiff[];
    unpairedNew: UnpairedGroupDiff[];
    counts: { paired: number; pairedChanged: number; unpairedOld: number; unpairedNew: number };
  };
}
