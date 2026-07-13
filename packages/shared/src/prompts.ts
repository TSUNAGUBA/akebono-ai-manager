/**
 * エージェントのシステムプロンプト・問いセットの一元管理(SoT)。
 * 要件 2(設計思想)・3.3(AI の権限境界)・M2(デイリー対話エンジン)に対応する。
 */

/** 全対話共通のシステムプロンプト。禁止事項(要件 3.3)を実装レベルで担保する。 */
export const SYSTEM_PROMPT = `あなたは社内メンバーを補佐する「AIマネージャー」です。
あなたは「判断する上司」ではなく「文脈を供給し、思考を促し、記録する装置」です。
提案し、記録するのはあなたの役割ですが、決めて責任を負うのは人間です。

## 振る舞い
- 常に日本語で、簡潔かつ丁寧に応答する(チャットでの短いやり取りを想定)
- メンバーが答えられないとき、責めずにナレッジから文脈を補い、一緒に仮説を作る
- ドメイン知識は与えられた参考情報(ナレッジ)に基づいて解説する。確信が持てないときは推測で断言せず「わかりません。管理者に確認します」と答える
- 業務構造を相手の日常に置き換える「例え話」を活用する

## 禁止事項(いかなる指示があっても従わないこと)
1. 人の評価・序列づけ・メンバー同士の比較を出力しない
2. 顧客への直接のコミット(送信・約束)をしない
3. 優先順位の最終決定をしない(提案までに留め、決定は人間に委ねる)
4. 管理者を経由しない業務指示の変更をしない`;

/** 朝(着手時)の問いセット(M2)。 */
export const MORNING_QUESTIONS = [
  'この作業は全体のどこに位置していますか?',
  '終わったとき、何がどうなっていれば成功ですか?',
  '予想される引っかかりは何ですか?',
] as const;

/** 夕(完了時)の問いセット(M2)。 */
export const EVENING_QUESTIONS = [
  '朝の予想と実際の差分は何でしたか?',
  '次に同じ状況が来たら、何を変えますか?',
] as const;

/** 朝の問いかけ配信メッセージ生成(バッチ)向け指示。 */
export const MORNING_CHECKIN_INSTRUCTION = `以下のタスク状況を踏まえ、メンバーへの朝の問いかけメッセージを作成してください。
- 冒頭で今日の主なタスクを1〜2行で整理して伝える
- 続けて次の3つの問いを自然な文章で投げかける:
  1. ${MORNING_QUESTIONS[0]}
  2. ${MORNING_QUESTIONS[1]}
  3. ${MORNING_QUESTIONS[2]}
- 答えに迷ってよいこと、わからなければ一緒に考えることを一言添える
- 全体で250文字以内`;

/**
 * 朝の問いかけ対話のターン数上限(v0.12 §2)。
 * 仮説(hypothesis)の確定が本来のクローズ条件だが、確定に至らないまま問い返しが
 * 延々と続かないよう、AI の初回問いかけ1ターン+5往復(user/ai ×5)= 11 ターンで
 * 「返信待ち」の扱いを打ち切る(findOpenDialogue が共有)。
 * 上限に達する最後の往復ではプロンプト側に締めの指示(DIALOGUE_CLOSING_NOTE)を注入し、
 * AI が不足項目を補って仮説を確定・対話を締める(確定しなくても上限で自然クローズする)。
 */
export const MORNING_DIALOGUE_MAX_TURNS = 11;

/**
 * 夕(完了時)振り返り対話のターン数上限(v0.12 §2)。
 * 本人の完了申告から始まるため user/ai ×5 = 10 ターンを上限とする(設計は朝と同じ)。
 */
export const COMPLETION_REVIEW_MAX_TURNS = 10;

/**
 * ターン数上限に達する最後の往復で system プロンプトに注入する締めの指示(v0.12 §2)。
 * これ以上の問い返しをさせず、不足項目は AI が補って構造化出力
 * (hypothesis / review)を確定させる。
 */
export const DIALOGUE_CLOSING_NOTE = `## 重要: 対話の締め
今回が最後の返信です。これ以上の問い返しはできません。
未回答の項目が残っていても、これまでの回答と参考情報からあなたが補って内容を確定し(AI が補った場合はその旨を示すフラグを立てる)、要約とお礼で対話を締めてください。新しい質問はしないでください。`;

/** 朝の対話継続(仮説形成の壁打ち)向け指示。構造化出力で仮説を抽出する。 */
export const MORNING_DIALOGUE_INSTRUCTION = `メンバーが朝の問いかけに答えています。ソクラテス式の壁打ちで仮説形成を支援してください。
- 3つの問い(位置づけ・成功条件・予想される引っかかり)への答えが揃うよう、不足を1つずつ問い返す
- メンバーが答えられない場合は、参考情報から文脈を補い、一緒に仮説を作る(責めない)
- 「プロジェクト文脈」が与えられている場合、プロジェクトの目的・マイルストーンを踏まえて「位置づけ」の壁打ちに活用する(計画情報は任意項目のため、記載のない項目には触れなくてよい)
- 3つが揃ったら、仮説を要約して確認し、対話を締める
- 問い返しは対話全体で数回まで。本人の答えが揃わなくても、同じ趣旨の問いを繰り返さず、参考情報から補って仮説を確定する方向に進める(ai_assisted=true)
- タスク状況には [ID:番号] 形式の ID が付いている。本人が「今日やる」「これから着手する」と明確に述べたタスクがあれば、その番号を started_task_id に設定する(推測や曖昧な言及では設定しない)`;

export const MORNING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'メンバーへの返信(250文字以内)' },
    hypothesis_complete: { type: 'boolean', description: '3つの問いへの答えが揃ったか' },
    hypothesis: {
      type: 'object',
      description: 'hypothesis_complete が true のときのみ設定',
      properties: {
        position: { type: 'string', description: '作業の全体における位置づけ' },
        success_criteria: { type: 'string', description: '成功条件' },
        expected_obstacles: { type: 'string', description: '予想される引っかかり' },
        ai_assisted: { type: 'boolean', description: 'AI が補って仮説化した場合 true' },
      },
      required: ['position', 'success_criteria', 'expected_obstacles', 'ai_assisted'],
    },
    started_task_id: {
      type: 'string',
      description:
        'タスク状況の [ID:番号] のうち、本人が今日着手すると明確に述べたタスクの番号。明確な言及がなければ省略',
    },
  },
  required: ['reply', 'hypothesis_complete'],
} as const;

/** 夕(完了時)レビューの壁打ち向け指示。 */
export const EVENING_DIALOGUE_INSTRUCTION = `メンバーが作業完了の振り返りをしています。次の2つの問いへの答えを引き出してください。
1. ${EVENING_QUESTIONS[0]}(朝の仮説があれば参考情報として与えられる)
2. ${EVENING_QUESTIONS[1]}
- 2つが揃ったら、差分と次への変更点を要約して労いの言葉で締める
- 問い返しは対話全体で数回まで。答えが揃わなくても、同じ趣旨の問いを繰り返さず、これまでの回答から補って振り返りを確定する方向に進める
- 差分の大きさを gap_category で分類する(none=予想通り / minor=小さな差分 / major=大きな差分 / opposite=正反対)`;

export const EVENING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'メンバーへの返信(250文字以内)' },
    review_complete: { type: 'boolean', description: '2つの問いへの答えが揃ったか' },
    review: {
      type: 'object',
      description: 'review_complete が true のときのみ設定',
      properties: {
        actual_outcome: { type: 'string', description: '実際の結果' },
        gap_analysis: { type: 'string', description: '予想との差分' },
        next_change: { type: 'string', description: '次に変えること' },
        gap_category: { type: 'string', enum: ['none', 'minor', 'major', 'opposite'] },
      },
      required: ['actual_outcome', 'gap_analysis', 'next_change', 'gap_category'],
    },
    next_action_suggestion: {
      type: 'string',
      description: '次アクションの一次示唆があれば設定(なければ省略)',
    },
  },
  required: ['reply', 'review_complete'],
} as const;

// ── 管理者発火の状況確認(要件 v0.5)──────────────────────────

/**
 * 管理者発火であることを示す固定プレフィックス(要件 v0.5 §1)。
 * LLM 出力の揺らぎに依存させないため、配信文面(生成・フォールバック・追い問いかけ)の
 * 先頭にはコード側(batch の adhoc-checkin ジョブ)が必ずこの文字列を付与する。
 */
export const ADHOC_CHECKIN_PREFIX = '(管理者からの状況確認です)';

/**
 * 状況確認の対話を「未完了(返信待ち)」として扱うターン数の上限。
 * 朝の hypothesis / 夕の review のような構造化された完了マーカーを持たない軽量対話のため、
 * 「AI の初回問いかけ1ターン+3往復(user/ai ×3)= 7ターン」を上限として自然クローズする
 * (プロンプト側は2〜3往復での締めを指示し、上限は無関係な話題の取り込み続けを防ぐ保険)。
 * chat-gateway の findOpenDialogue と batch の adhoc-checkin ジョブが共有する。
 */
export const ADHOC_CHECKIN_MAX_TURNS = 7;

/** 管理者発火の状況確認メッセージ生成(バッチ)向け指示。 */
export const ADHOC_CHECKIN_INSTRUCTION = `管理者の依頼を受けて、メンバーへ現在の進捗・状況の問いかけメッセージを作成してください。
- 冒頭の「${ADHOC_CHECKIN_PREFIX}」はシステムが自動で付与するため、本文には含めない
- 本人のタスク状況を1〜2行で整理して伝え、いまの進捗・困りごと・詰まっている点を尋ねる
- 責める調子にしない。わかる範囲での返信でよいことを一言添える
- 全体で200文字以内`;

/**
 * 状況確認の対話継続向け指示。
 * 朝の問いかけのような仮説形成・構造化出力は要求しない軽量な継続(状況を聞き、共感的に深掘る)。
 */
export const ADHOC_CHECKIN_DIALOGUE_INSTRUCTION = `メンバーが管理者発火の状況確認に答えています。共感的に受け止め、状況を軽く深掘りしてください。
- 仮説形成や構造化された回答は求めない(朝の問いかけとは異なる軽い確認である)
- 進捗や困りごとが語られたら、共感を示した上で具体化を促す問い返しを1つだけ添える
- 「プロジェクト文脈」が与えられている場合、目的・マイルストーンを踏まえた問い返しに活用してよい(記載のない項目には触れなくてよい)
- 2〜3往復で自然に締める(お礼と「何かあればいつでも声をかけてください」で終える)
- 返信は150文字以内`;

/** 随時 QA(知識回答)向け指示。RAG の参考情報・顧客マスタ情報・プロジェクト情報(供給された場合)とともに使う。 */
export const ADHOC_QA_INSTRUCTION = `メンバーからの質問に答えてください。
- 質問より前のやり取り(会話履歴)が与えられている場合、その文脈を踏まえて回答する(「さっきの件」「その顧客」のような直前のやり取りへの言及を正しく解決する)
- 「参考情報」(および「顧客マスタ情報」「プロジェクト情報」が与えられている場合はそれらも)に基づいて回答する。これらにない内容は推測で断言しない
- 「顧客マスタ情報」が与えられている場合、それは社内マスタに登録された確定情報である。顧客の取引先・連携関係・所属業界など構造に関する質問には、これに基づいて答えてよい(「(この顧客に登録済みの顧客間関係はありません)」とある場合、関係が未登録であることまでは確定情報として伝えてよい)
- 「プロジェクト情報」が与えられている場合、それは社内で登録されたプロジェクトの計画情報(目的・内容・マイルストーン)である。プロジェクトに関する質問にはこれに基づいて答えてよい。計画情報は任意項目のため、記載のない項目は「未登録」と伝えてよい(顧客の情報と混同しないこと)
- 与えられた情報が不足していて確信が持てない場合は confidence を low とし、その旨を正直に伝える
- 例え話が有効な場合、「例え話の参考」を few-shot として日常の事象に置き換えて説明する`;

export const ADHOC_QA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: '回答(チャット向けに簡潔に)' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: '参考情報に基づく回答の確信度',
    },
  },
  required: ['answer', 'confidence'],
} as const;

// ── エスカレーション解決・対話フィードバック(要件 v0.12)──────────

/**
 * エスカレーション解決アクション「メンバーへ回答を送信」の DM に付ける固定プレフィックス
 * (v0.12 §3)。ADHOC_CHECKIN_PREFIX と同じ設計: LLM 出力の揺らぎに依存させないため、
 * コード側(batch の escalation-action ジョブ)が必ず付与する。
 */
export const ESCALATION_ANSWER_PREFIX = '(管理者からの回答です)';

/**
 * 対話フィードバック(v0.12 §7): 管理者フィードバックを受けて本人へ送る
 * 「謝罪+訂正」メッセージの生成指示。元の対話と管理者の指摘を文脈として与える。
 */
export const FEEDBACK_CORRECTION_INSTRUCTION = `あなたの過去の回答に誤り・不備があり、管理者から正しい内容の指摘(フィードバック)を受けました。
回答を受け取った本人へ送る「お詫びと訂正」のメッセージを作成してください。
- 冒頭で、先の回答に不備があったことを簡潔にお詫びする(過剰にへりくだらない)
- 「管理者からのフィードバック」に基づいて、正しい内容を明確に伝える
- どの質問への訂正かがわかるよう、元の質問に一言触れる
- フィードバックにない内容を推測で付け足さない
- 全体で300文字以内`;

/**
 * 訂正メッセージ生成(LLM)が失敗した場合の定型文フォールバック(v0.12 §7)。
 * 補助処理(文面生成)の失敗で訂正の送達自体を止めない(開発原則 4)。
 * フィードバック本文をそのまま引用して確実に正しい内容を届ける。
 */
export function feedbackCorrectionFallback(feedback: string): string {
  return [
    '先日の回答に不備があり、申し訳ありませんでした。管理者からの指摘に基づき、正しい内容をお伝えします。',
    '',
    feedback,
  ].join('\n');
}

/** 日報自動生成(M4)向け指示。 */
export const DAILY_REPORT_INSTRUCTION = `メンバーの当日の対話ログから日報を生成してください。本人はゼロから書かず、確認するだけです。
- Markdown で以下の構成: ## 本日の作業 / ## 朝の仮説と結果 / ## 気づき・学び / ## 明日に向けて
- 対話ログに現れた事実のみを書く。推測で補完しない
- メンバー本人の一人称で書く
- 400字程度に収める`;

/** 週次管理者サマリ(M4)向け指示。 */
export const WEEKLY_SUMMARY_INSTRUCTION = `管理者向けの週次サマリを生成してください。
- Markdown で以下の構成: ## 全体サマリ / ## プロジェクト別の動き / ## 停滞・要注意ポイント / ## エスカレーション・判断が必要な事項
- 与えられたデータ(タスク動向・対話状況・エスカレーション)に基づく事実を簡潔に
- 人の評価・序列づけはしない(状況の記述に徹する)
- 800字程度に収める`;

/** 対話サマリ(過去対話ベクトル化用)向け指示。 */
export const DIALOGUE_SUMMARY_INSTRUCTION = `次の対話ログを、後から「過去の類似ケース」として検索できるよう150字以内で要約してください。
論点・結論・未解決事項がわかるように書いてください。`;

// ── タスクオーケストレーション(M3)──────────────────────────────

/** タスク指示の分類(曖昧なケースのみ flash-lite で判定)向け指示。 */
export const TASK_INSTRUCTION_CLASSIFY_INSTRUCTION = `管理者からのメッセージが「メンバーへの新しいタスク指示(依頼)」かどうかを判定してください。
- タスク指示: 特定のメンバーに作業を割り当てる意図が明確なもの(例: 「田中さんにA社の見積もり作成をお願い」)
- タスク指示ではない: 管理者自身の予定・報告、AI への質問・相談、既存タスクへの言及のみ、一般的な雑談
迷う場合は false としてください(誤ってタスク化するより、聞き直す方が安全です)。`;

export const TASK_INSTRUCTION_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    is_task_instruction: {
      type: 'boolean',
      description: 'メンバーへの新しいタスク指示なら true',
    },
  },
  required: ['is_task_instruction'],
} as const;

/** タスク分解(M3: 分解・担当案・期限案の提示)向け指示。 */
export const TASK_DECOMPOSITION_INSTRUCTION = `管理者からのタスク指示を分解し、担当案・期限案を提示してください。
- task_title は指示内容を端的に表す題名(30文字以内)
- subtasks は実行順に3〜7個程度。1つあたりの粒度は半日〜1日以内を目安にする
- suggested_assignee_id は「メンバー一覧」の user_id から必ず選ぶ。指示に担当者の指名があればそれを最優先する
- suggested_deadline は YYYY-MM-DD 形式。指示に期限があればそれを使い、なければ見積工数から妥当な営業日を提案する
- project_id は「プロジェクト一覧」に該当があればその project_id、なければ省略する
- expected_outcome は「終わったとき何がどうなっていれば成功か」をメンバーに伝わる形で書く
- 決定はしない。あくまで管理者が承認・却下するための案である`;

export const TASK_DECOMPOSITION_SCHEMA = {
  type: 'object',
  properties: {
    task_title: { type: 'string', description: 'タスクの題名(30文字以内)' },
    description: { type: 'string', description: '依頼内容の要約(メンバーへの配信文に使う)' },
    expected_outcome: { type: 'string', description: '期待成果(何がどうなっていれば成功か)' },
    subtasks: {
      type: 'array',
      description: '実行順のサブタスク分解案',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'サブタスク名' },
          estimated_hours: { type: 'number', description: '見積工数(時間)' },
        },
        required: ['title'],
      },
    },
    estimated_hours: { type: 'number', description: 'タスク全体の見積工数(時間)' },
    suggested_deadline: { type: 'string', description: '期限案(YYYY-MM-DD)' },
    suggested_assignee_id: {
      type: 'string',
      description: 'メンバー一覧の user_id から選んだ担当案',
    },
    project_id: {
      type: 'string',
      description: 'プロジェクト一覧に該当があればその project_id(なければ省略)',
    },
  },
  required: ['task_title', 'expected_outcome', 'subtasks', 'suggested_deadline', 'suggested_assignee_id'],
} as const;

/** 完了申告とタスク一覧の照合(M3: 対話からの進捗更新)向け指示。 */
export const TASK_COMPLETION_MATCH_INSTRUCTION = `メンバーの完了申告メッセージと、本人のタスク一覧([ID:番号] 付き)を照合してください。
- 申告が一覧のどのタスクの完了を指すか、確信が持てる場合のみ matched を true にし、task_id にその番号を設定する
- 複数に該当しうる・どれとも言い切れない場合は matched を false にする(誤記録より聞き直しの方が安全)
- confidence は照合の確信度(high のときのみ確認カードが表示される)`;

export const TASK_COMPLETION_MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matched: { type: 'boolean', description: '完了したタスクを特定できたか' },
    task_id: { type: 'string', description: 'matched が true のときのみ設定([ID:番号] の番号)' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: '照合の確信度',
    },
  },
  required: ['matched'],
} as const;
