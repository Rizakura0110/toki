# Toki repository working agreements

- Tokiは`rizakura-hontai`と独立したGit repository・Worker・D1です。基盤や他製品のsource/packageを直接importせず、基盤との連携は通常のリンクに限定します。
- 1フェーズずつ進め、必要なformat、lint、生成型、TypeScript、test/coverage、local D1、dry-run build、dependency auditを通してから差分・ignore・秘密情報を確認し、in-scope変更をcommit/pushします。
- 依存versionは完全固定し、`pnpm-workspace.yaml`の7日gate、lockfile/integrity、strict peer、install script制限を維持します。Wranglerの生成型`worker-configuration.d.ts`だけは検査済みsnapshotとして追跡します。build成果物・cache・資格情報・本人email・実データはcommitしません。
- 通常のGit pushは本番deploy、Cloudflare resource作成、remote migration、課金変更を許可しません。本番操作には対象を明示した別承認が必要です。
- Phase 36は非機密のlocal接続stubだけです。業務table/API、Access JWT検証、画面、PWAは後続フェーズに分けます。

## 技術スタック統一方針

- 2026-10-04の所有者指示により、Tokiも基盤・Tech Inbox・Daymarkと技術を揃える。目標はTypeScript、React/React DOM・React Router、Tailwind CSS・Vite（React/Tailwind/Cloudflare plugins）、Hono、Drizzle ORM/D1。Zod・jose/Cloudflare Access、Node.js/pnpm・Wrangler・Biome・Vitest/Testing Library・Playwright・GitHub Actionsも共通基準に揃える。
- 別repository・別Worker・別D1・別Accessと入口リンクの境界は維持し、基盤や他製品の実装をimportしない。既存の素のJavaScript・独自router・直接SQLは移行元であり、新製品用の標準ではない。
- 基盤の検証済み完全versionと依存基準を出発点とし、導入前に脆弱性・互換性・7日gate・integrityを再確認する。独断で別技術へ置換・省略しない。例外が必要なら理由と比較案を提示し、所有者の承認を得る。
- 移行は基盤repositoryの`docs/toki-roadmap.md` Phase 49〜56に従う。Phase 51はViteとReact/Tailwindの開発基盤で、現行HTML/DOM画面を保持する。Hono・Drizzle・React画面への置換は順にPhase 52〜54、本番変更は別承認後のPhase 56。既存の機能、API、記録と未完了計測、URL、PWA identityを保ち、物理DB schema/migration変更は前提にしない。
- ローカルDBの保存先はmigration・検査・開発起動で同じ`.wrangler/state`へ明示固定する。Viteの`dist`配下へ永続データを置かない。開発/E2Eもbuild済みWorkerとassetsを配信し、HMRのために本番CSP・認証を緩めない。

## Cloudflare認証の誤診を繰り返さないための必須手順

- 2026-09-23は最新tokenが有効なのに期限切れと誤診した。原因は古い継承環境、制御文字入りAccount ID、sandbox内の`launchctl getenv`が空になる挙動の誤認だった。許可されたsandbox外で最新設定を取得し、子プロセスへ明示することで、再ローテーション・再起動なしにdeployできた。
- HTTP 401だけで期限切れ、sandbox内で空というだけでOS上の未設定と断定しない。当日成功したdeployのログと資格情報の取得元を先に照合し、プロセスの継承値・別Terminalの`export`・OSの保存値を区別する。実行制限が影響する場合は正式な権限確認の仕組みで検証し、制限を迂回しない。
- 最新の取得元でCloudflare tokenの有効性と対象accountを確認する。Account IDは形式を厳密に検査し、推測で補正しない。検証済み値だけをWrangler子プロセスの環境へ明示し、値を標準出力・引数・Git・共有ログへ出さない。
- 以上を調べて必要性が判明するまでは、所有者へ再ローテーション・再入力・アプリ再起動を求めない。有効tokenの権限不足やaccount不一致は期限切れと区別する。解決できない場合も、確認した根拠・不明点・本当に必要な操作を示す。基盤repositoryの`docs/toki-operations.md`に詳細な事例と手順がある。
