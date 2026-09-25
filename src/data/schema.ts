/**
 * 同梱する有報の逐語段落 — 器とスキーマ。
 *
 * 正本 = design-v0.md §4.5 / go-decision-v0.md §9.2 G-C1〜G-C3・G-D1
 * （`~/projects/cabocia/hq/reports/dexter-tv-jev/`）。
 *
 * データ本体（実際の有報段落）はこのファイルには置かない。実データは
 * `src/data/materials/*.json` に 1 ファイル = 素材 1 件（または配列）で置く
 * （`materials/README.md` 参照）。ここにあるのは型とバリデーションだけ。
 *
 * ネットワーク・ファイル I/O なし。純関数。
 */

/** G-C1: 同梱できる出所は EDINET（有報）のみ。短信・各社 IR 由来は不可。 */
export const EDINET_SOURCE = 'edinet' as const;

/** G-C2: 編集・加工の主体は固定。EDINET 利用規約「編集・加工等を行ったこと及びその主体を記載」に対応。 */
export const REQUIRED_EDITOR = 'Cabocia' as const;

/** G-C2: PDL1.0 の出典記載例の書き出し（go-decision §5.1 の EDINET 利用規約 引用そのまま）。 */
export const REQUIRED_CITATION_PREFIX = '出典：EDINET閲覧（提出）サイト';

/** G-C2: 出典表記に PDL1.0 への言及が要る。 */
export const REQUIRED_CITATION_MARKER = 'PDL1.0';

/**
 * 同梱素材 1 件。
 *
 * `docId` / `filer` / `documentType` / `section` / `acquiredDate` / `citation` /
 * `editor` が go-decision-v0.md §9.2 G-C2 の「出所メタ 7 項目」。
 */
export interface BundledMaterial {
  /** 短信・各社 IR ではなく有報のみ（G-C1）。'edinet' 固定。 */
  source: string;
  /** EDINET の書類管理番号（例: S100XXXX）。 */
  docId: string;
  /** 提出者（会社名）。 */
  filer: string;
  /** 書類種別（例: 有価証券報告書）。 */
  documentType: string;
  /** 箇所（節。例: 経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析）。 */
  section: string;
  /** 取得日（YYYY-MM-DD）。 */
  acquiredDate: string;
  /** 出典表記。規定の形式（`REQUIRED_CITATION_PREFIX` + `REQUIRED_CITATION_MARKER` を含む）。 */
  citation: string;
  /** 編集・加工の主体。`REQUIRED_EDITOR` 固定。 */
  editor: string;
  /** 逐語段落本文。 */
  text: string;
}

/** 出所メタ 7 項目。G-C2 が「1 項目でも欠けたら build 失敗」というときの対象（`source`・`text` は別枠）。 */
export const PROVENANCE_META_FIELDS: ReadonlyArray<keyof BundledMaterial> = [
  'docId',
  'filer',
  'documentType',
  'section',
  'acquiredDate',
  'citation',
  'editor',
];

const ACQUIRED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MaterialValidationError {
  field: string;
  /** 'G-C1' | 'G-C2' | その他の非ゲート起因（構造エラー等）。 */
  code: string;
  message: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 1 件を検証する純関数。`value` は JSON.parse 直後の unknown を想定
 * （実データが壊れていても例外を投げず、エラーの配列で返す）。
 *
 * @param label エラーメッセージに出す識別子（例: ファイル名 + index）
 */
export function validateMaterial(value: unknown, label = '(素材)'): MaterialValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', code: 'not_object', message: `${label}: 素材はオブジェクトである必要があります` }];
  }

  const material = value as Record<string, unknown>;
  const errors: MaterialValidationError[] = [];

  // G-C1: source は edinet のみ。
  if (material.source !== EDINET_SOURCE) {
    errors.push({
      field: 'source',
      code: 'G-C1',
      message: `${label}: source が '${String(material.source)}' です。同梱できるのは source: '${EDINET_SOURCE}' のみ（短信・各社IR由来は不可）`,
    });
  }

  // G-C2: 出所メタ 7 項目が全部、空でない文字列であること。
  for (const field of PROVENANCE_META_FIELDS) {
    if (!isNonEmptyString(material[field])) {
      errors.push({
        field,
        code: 'G-C2',
        message: `${label}: 出所メタ '${field}' が欠けています（空文字列・未定義を含む）`,
      });
    }
  }

  // acquiredDate の形式（値が入っている場合のみ形式を追加チェック）。
  if (isNonEmptyString(material.acquiredDate) && !ACQUIRED_DATE_RE.test(material.acquiredDate)) {
    errors.push({
      field: 'acquiredDate',
      code: 'G-C2',
      message: `${label}: acquiredDate は YYYY-MM-DD 形式で書きます（実際: '${material.acquiredDate}'）`,
    });
  }

  // citation の規定書式。
  if (
    isNonEmptyString(material.citation) &&
    (!material.citation.includes(REQUIRED_CITATION_PREFIX) || !material.citation.includes(REQUIRED_CITATION_MARKER))
  ) {
    errors.push({
      field: 'citation',
      code: 'G-C2',
      message: `${label}: citation は規定の形式（${REQUIRED_CITATION_PREFIX}（URL）、${REQUIRED_CITATION_MARKER}（URL）を含む）で書きます`,
    });
  }

  // editor は固定値。
  if (isNonEmptyString(material.editor) && material.editor !== REQUIRED_EDITOR) {
    errors.push({
      field: 'editor',
      code: 'G-C2',
      message: `${label}: editor は '${REQUIRED_EDITOR}' 固定です（実際: '${material.editor}'）`,
    });
  }

  // text はメタではないが素材として必須。
  if (!isNonEmptyString(material.text)) {
    errors.push({ field: 'text', code: 'missing_text', message: `${label}: text が空です` });
  }

  return errors;
}

/** `validateMaterial` の結果が「合格」かどうか。 */
export function isValidMaterial(value: unknown): value is BundledMaterial {
  return validateMaterial(value).length === 0;
}
