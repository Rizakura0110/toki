# Toki repository working agreements

- Tokiは`rizakura-hontai`と独立したGit repository・Worker・D1です。基盤や他製品のsource/packageを直接importせず、基盤との連携は通常のリンクに限定します。
- 1フェーズずつ進め、必要なformat、lint、生成型、TypeScript、test/coverage、local D1、dry-run build、dependency auditを通してから差分・ignore・秘密情報を確認し、in-scope変更をcommit/pushします。
- 依存versionは完全固定し、`pnpm-workspace.yaml`の7日gate、lockfile/integrity、strict peer、install script制限を維持します。Wranglerの生成型`worker-configuration.d.ts`だけは検査済みsnapshotとして追跡します。build成果物・cache・資格情報・本人email・実データはcommitしません。
- 通常のGit pushは本番deploy、Cloudflare resource作成、remote migration、課金変更を許可しません。本番操作には対象を明示した別承認が必要です。
- Phase 36は非機密のlocal接続stubだけです。業務table/API、Access JWT検証、画面、PWAは後続フェーズに分けます。
