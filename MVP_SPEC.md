# 逢いカメラ MVP 仕様書 (Flutter + Supabase)

## 1. ゴール
- ツーショット撮影直後に新入生の顔をマッチし、プロフィールをポップアップ表示。
- 画像は端末ローカルのみ保存。クラウドは顔ベクトル + プロフィールのみ。

## 2. スコープ (MVP)
- 対応端末: iOS / Android (Flutter)。Webは非対象。
- 機能: 撮影 → 顔検出 → 埋め込み生成 → Supabase類似検索 → プロフィール表示。
- ポップアップUIで上位候補1〜3件を提示し、選択でプロフィール詳細へ遷移。
- ローカル画像自動ローテーション (最大枚数/日数設定)。
- 簡易紹介文はテンプレ生成（LLMなし）。

## 3. 非スコープ (後続)
- Web管理画面、AI要約API、クラウド画像保存、通知、多言語切替。

## 4. アーキテクチャ
- クライアント: Flutter (Dart)
  - カメラ: `camera`
  - 顔検出: `google_mlkit_face_detection`
  - 埋め込み生成: `tflite_flutter` + 量子化 FaceNet / MobileFaceNet (.tflite 同梱)
  - ローカルDB: `hive` または `sqflite` (プロフィール/埋め込みキャッシュ)
  - 状態管理: `riverpod` または `bloc` (任意)
- BaaS: Supabase Free
  - DB: Postgres + pgvector
  - Auth: Email / Magic Link
  - Edge Functions: `/match` 類似検索
  - Storage: 未使用 (画像アップロードなし)

## 5. データモデル (Supabase)
```sql
create extension if not exists vector;

create table freshmen (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text,
  hobbies text[],
  tags text[],
  bio text,
  created_at timestamptz default now()
);

create table face_embeddings (
  id uuid primary key default gen_random_uuid(),
  freshman_id uuid references freshmen(id) on delete cascade,
  embedding vector(512) not null,
  model text not null,
  created_at timestamptz default now()
);

create table match_logs (
  id uuid primary key default gen_random_uuid(),
  freshman_id uuid references freshmen(id) on delete set null,
  similarity real,
  shot_at timestamptz default now(),
  device_id text,
  note text
);
```

### RLS ポリシー例
```sql
-- 役割は auth JWT の claim `role` を想定
alter table freshmen enable row level security;
alter table face_embeddings enable row level security;
alter table match_logs enable row level security;

create policy "read_freshmen_upper" on freshmen
  for select using (auth.jwt() ->> 'role' = 'upperclass');

create policy "insert_embeddings_admin" on face_embeddings
  for insert using (auth.jwt() ->> 'role' = 'admin');

create policy "read_embeddings_upper" on face_embeddings
  for select using (auth.jwt() ->> 'role' = 'upperclass');

create policy "insert_logs_auth" on match_logs
  for insert using (auth.role() = 'authenticated');
```

## 6. Edge Function `/match`
- 役割: 埋め込みを受け取り、pgvectorで上位3件を返却。
- ランタイム: Deno (Supabase Functions デフォルト)

```ts
// supabase/functions/match/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const { embedding, limit = 3 } = await req.json();
    if (!embedding || !Array.isArray(embedding)) {
      return new Response(JSON.stringify({ error: "embedding required" }), { status: 400 });
    }

    const { data, error } = await supabase.rpc('match_faces', {
      query_embedding: embedding,
      match_limit: limit
    });
    if (error) throw error;

    return new Response(JSON.stringify({ candidates: data }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
```

### RPC (Postgres function)
```sql
create or replace function match_faces(query_embedding vector, match_limit int default 3)
returns table (
  freshman_id uuid,
  name text,
  department text,
  tags text[],
  bio text,
  distance float
) language sql stable as $$
  select f.id, f.name, f.department, f.tags, f.bio,
         fe.embedding <=> query_embedding as distance
  from face_embeddings fe
  join freshmen f on f.id = fe.freshman_id
  order by fe.embedding <=> query_embedding
  limit match_limit;
$$;
```

## 7. 端末ストレージ方針
- 保存: アプリ専用ディレクトリ (iOS sandbox / Android `getExternalFilesDir`).
- 同期: ギャラリー非公開。
- 自動削除: デフォルト「直近50枚 or 7日」超過分をクリーンアップ。

## 8. オフライン戦略
- プロフィール & 埋め込みをローカルDBにキャッシュ。
- オフライン時はローカルで簡易L2類似検索を実施し暫定候補を提示。
- 復帰時に match_logs を一括送信。

## 9. Flutter 実装メモ
- 主要パッケージ
  - camera
  - google_mlkit_face_detection
  - tflite_flutter
  - supabase_flutter
  - riverpod / bloc (状態管理)
  - hive / sqflite (キャッシュ)

- マッチフロー擬似コード
```dart
final image = await controller.takePicture();
final faces = await mlkit.detect(image.path);
final target = selectFreshmanFace(faces); // UIで選択 or 最大顔
final embedding = await embeddingModel.embed(image.path, target.box);

final res = await supabase.functions.invoke('match',
  body: {'embedding': embedding});
final candidates = (res.data['candidates'] as List)
    .map((e) => Candidate.fromJson(e))
    .toList();

showPopup(image.path, candidates); // プレビュー上に半透明カード
```

## 10. テスト観点
- 権限: カメラ・ストレージ許諾文言、拒否時のハンドリング。
- 精度: 照度/角度/マスク有無でのマッチ率測定。
- パフォーマンス: 撮影→結果表示まで1.5秒以内を目標。
- ストレージ: 自動削除ポリシー動作、ギャラリー非公開確認。

## 11. ロードマップ (初期2スプリント)
- Sprint1: Supabaseスキーマ+RLS、/match関数+RPC、Flutterで撮影→検出→埋め込み→API疎通、ポップアップ試作。
- Sprint2: ローカルキャッシュ+自動削除、オフライン暫定マッチ、UI磨きとバグ修正、計測ログ整備。
```
