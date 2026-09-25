# `src/data/materials/`

同梱する有報の逐語段落を置くディレクトリです。**1 ファイル = 素材 1 件**
（または `BundledMaterial[]` の配列）の JSON を、このディレクトリの直下に
置きます。サブディレクトリ（`__fixtures__/` 等）は build ゲートの対象外です。

## 素材ファイルの形

各ファイルは `../schema.ts` の `BundledMaterial` 型に沿った JSON です:

```json
{
  "source": "edinet",
  "docId": "S100XXXX",
  "filer": "○○株式会社",
  "documentType": "有価証券報告書",
  "section": "事業等のリスク",
  "acquiredDate": "2026-09-22",
  "citation": "出典：EDINET閲覧（提出）サイト（https://...）、PDL1.0（https://www.digital.go.jp/resources/open_data/public_data_license_v1.0）",
  "editor": "Cabocia",
  "text": "..."
}
```

## ライセンス

このディレクトリの JSON は**リポジトリの MIT ライセンス（`../../../LICENSE`）
の対象ではありません**。利用条件は `../../../LICENSE-DATA` を参照してください。

## build ゲート

`bun run check:data`（= `../check.ts`）が、このディレクトリ直下の全 `*.json`
を検証します:

- `source` が `edinet` でなければ build 失敗（G-C1、短信・各社 IR 由来は不可）
- 出所メタ 7 項目（`docId` / `filer` / `documentType` / `section` /
  `acquiredDate` / `citation` / `editor`）が 1 つでも欠けていれば build 失敗（G-C2）
- `text` に個人名らしき表現を検出したら build 失敗（G-D1。検出は決定論の
  一次防御で、完璧な固有表現抽出ではない。`../person-names.ts` 参照）

## 現状

このディレクトリは現時点ではプレースホルダです。実データ（EDINET DB から
機械生成した有報段落）は別便で投入されます。空の状態でも `check:data` は
通ります（実データ未投入の段階を build 失敗にしない）。
