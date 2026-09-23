# Toki repository working agreements

- Tokiは`rizakura-hontai`と独立したGit repository・Worker・D1です。基盤や他製品のsource/packageを直接importせず、基盤との連携は通常のリンクに限定します。
- 1フェーズずつ進め、必要なformat、lint、生成型、TypeScript、test/coverage、local D1、dry-run build、dependency auditを通してから差分・ignore・秘密情報を確認し、in-scope変更をcommit/pushします。
- 依存versionは完全固定し、`pnpm-workspace.yaml`の7日gate、lockfile/integrity、strict peer、install script制限を維持します。Wranglerの生成型`worker-configuration.d.ts`だけは検査済みsnapshotとして追跡します。build成果物・cache・資格情報・本人email・実データはcommitしません。
- 通常のGit pushは本番deploy、Cloudflare resource作成、remote migration、課金変更を許可しません。本番操作には対象を明示した別承認が必要です。
- Phase 36は非機密のlocal接続stubだけです。業務table/API、Access JWT検証、画面、PWAは後続フェーズに分けます。

## Cloudflare認証の誤診を繰り返さないための必須手順

- 2026-09-23は最新tokenが有効なのに期限切れと誤診した。原因は古い継承環境、制御文字入りAccount ID、sandbox内の`launchctl getenv`が空になる挙動の誤認だった。許可されたsandbox外で最新設定を取得し、子プロセスへ明示することで、再ローテーション・再起動なしにdeployできた。
- HTTP 401だけで期限切れ、sandbox内で空というだけでOS上の未設定と断定しない。当日成功したdeployのログと資格情報の取得元を先に照合し、プロセスの継承値・別Terminalの`export`・OSの保存値を区別する。実行制限が影響する場合は正式な権限確認の仕組みで検証し、制限を迂回しない。
- 最新の取得元でCloudflare tokenの有効性と対象accountを確認する。Account IDは形式を厳密に検査し、推測で補正しない。検証済み値だけをWrangler子プロセスの環境へ明示し、値を標準出力・引数・Git・共有ログへ出さない。
- 以上を調べて必要性が判明するまでは、所有者へ再ローテーション・再入力・アプリ再起動を求めない。有効tokenの権限不足やaccount不一致は期限切れと区別する。解決できない場合も、確認した根拠・不明点・本当に必要な操作を示す。基盤repositoryの`docs/toki-operations.md`に詳細な事例と手順がある。
