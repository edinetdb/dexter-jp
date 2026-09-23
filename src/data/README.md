# `src/data/`

demo・自社ベンチに同梱する有報の逐語段落の**器・ゲート・テスト**。実データは
`materials/`（別途投入。`materials/README.md` 参照）。

正本 = `~/projects/cabocia/hq/reports/dexter-tv-jev/design-v0.md` §4.5、
`go-decision-v0.md` §9.2 G-C1〜G-C3・G-D1。

| ファイル | 役割 |
|---|---|
| `schema.ts` | `BundledMaterial` 型 + `validateMaterial()`（G-C1・G-C2） |
| `person-names.ts` | 個人名検出（決定論、一次防御。G-D1） |
| `check.ts` | `checkMaterialsDir()` + `bun run check:data` の CLI エントリ |
| `materials/` | 実データ置き場（`*.json`、`LICENSE-DATA` 準拠） |
| `__fixtures__/` | テスト用の素材フィクスチャ（正常系・異常系） |

`check.ts` 以外はネットワーク・ファイル I/O なしの純関数。
