# Toki

Tokiは、ストップウォッチ・タイマーで測った時間に行動内容を付け、アプリ内カレンダーで振り返る本人用の時間管理アプリです。`rizakura-hontai`からは通常のリンクで移動し、Tokiの実行時コード・Worker・D1は独立させます。

## 現在の状態

Phase 37では独立したAccess JWT検証、ローカルD1の計測schema、計測・記録APIを実装しました。画面、PWA、Cloudflare Access application、本番Worker/DBはまだありません。通常の画面応答は`503`です。`/__local/db`はローカル起動時にだけ明示的な変数で有効化する接続検査で、業務データは返しません。

製品仕様とフェーズ計画は基盤repositoryの`docs/toki-design.md`・`docs/toki-roadmap.md`を正とします。このrepositoryへ基盤/Tech Inbox/Daymarkのsourceをコピーしたり、実データやCloudflare資格情報を追加したりしません。

## ローカル検証

Node.js `24.19.0`とpnpm `11.22.0`を使用します。依存・キャッシュ・一時ファイルはこのrepository内に保持します。

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`はformat、lint、生成型、TypeScript、coverage付きtest、local D1 migrationと`time_sessions`検査、Worker dry-run build、依存監査を実行します。Cloudflareのremote DBやWorkerは作成・変更しません。

必要な場合に限り、`pnpm dev`でローカルWorkerを起動できます。`/__local/db`とAPIの認証バイパスは明示的なローカル起動引数かつloopback HTTPに限定します。`.dev.vars`や`.env`は追跡しません。本番APIは本人限定Accessに加えてWorkerでJWTを検証します。
