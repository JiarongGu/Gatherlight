#!/usr/bin/env node
// judge-bench-long-fixture.mjs — writes devtools/fixtures/recall-bilingual-long.json: the SAME 60 facts and the SAME
// 240 questions as recall-bilingual.json, each fact's content turned into a LONG NOTE with the original content (the
// answer-bearing text) at a controlled POSITION. Deterministic and model-free: re-running it reproduces the committed
// file byte for byte, and `judge-bench --fixture=long` refuses to run when it does not (docs/judge-bench.md Run 6).
//
// WHY. RerankInputCap fits every (query, candidate) pair to a reranker's DECLARED window: mMiniLMv2 (512 tokens) reads
// at most 506 − |query| NFKC characters of each candidate, i.e. 342–490 characters for this fixture's questions (16–164
// characters long), while BGE and LAMAR (no declared window) read up to RerankInputCap.MaxChars = 1,000. The bilingual
// fixture's facts are ≤ 101 characters, so no run could show what cutting a LONG fact costs. Here the answer sits at:
//   start  — offset 0: every model reads it;
//   middle — offset 540–600, with about as much text after it: past mMiniLMv2's cut for EVERY question, inside 1,000;
//   end    — the last text of a 880–960-character note: past mMiniLMv2's cut, inside 1,000;
//   beyond — offset 1,060–1,120, the last text of the note: past 1,000 too, so BGE and LAMAR cannot read it either.
// Fifteen facts per position, assigned in fixture order WITHIN each language (zh 10, en 4, ja 1 per position), so
// the assignment is balanced by language and a near-duplicate cluster (adjacent in the fixture) is split across
// positions. The assignment is written into the fixture itself — it is pre-registered by being committed.
//
// WHAT THE PADDING IS, and why it is not other facts' content verbatim. Every one of the 60 facts is questioned, so
// copying fact Y's content into fact X's note would make note X a SECOND correct answer to Y's four questions: the
// question would be ambiguous and a "miss" on Y could be the answer landing on the page in X. So the padding carries
// NO fact's answer, by construction:
//   (1) OTHER FIXTURE FACTS, BY TOPIC ONLY — up to three per note, same language, in a sentence that states nothing
//       about them ("…另外有一条记录,这里不重复"). A topic is a headline and carries no value. The four topics that DO
//       carry part of their own answer are never mentioned (MENTION_EXCLUDED). They make the note "one that mentions
//       many things", and a question's subject then appears in other notes that do not answer it.
//   (2) NEUTRAL HOUSEHOLD FILLER — invented, fictional sentences (chores, repairs, family routines) that name none of
//       the fixture's subjects: every sentence is checked against SUBJECT_TERMS, a list of every fact's subject words
//       in all three languages, and the build fails on a hit.
// And every fact's original content occurs EXACTLY ONCE in the whole corpus — in its own note, at its declared offset.
//
// Usage:
//   node devtools/scripts/judge-bench-long-fixture.mjs            write the fixture (and print where each answer sits)
//   node devtools/scripts/judge-bench-long-fixture.mjs --check    exit 1 unless the committed file is what this writes
//   node devtools/scripts/judge-bench-long-fixture.mjs --measure --resources=devtools/_rr-res [--port=6250]
//       tokenize every note on dedicated CPU llama-servers (mMiniLMv2 and BGE, the catalogue's pinned files) and report
//       where each position lands against each model's cut, in characters and in tokens. Scratch output goes to
//       devtools/_judge-bench-long/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE_FIXTURE = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json');
export const LONG_FIXTURE = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual-long.json');

// ---- the cuts this fixture is built around (restated from RerankInputCap; the bench's mirror guard holds the window) --
/** RerankInputCap.MaxChars — what a reranker WITHOUT a declared window reads of each candidate. */
export const MAX_CHARS = 1000;
/** RerankInputCap.PairOverheadTokens. */
const PAIR_OVERHEAD = 6;
/** mMiniLMv2's declared window (GgufCatalog, ContextTokens: 512). */
const MINILM_WINDOW = 512;
/** RerankInputCap.Fit for a declared window: the query cut to half the budget, each candidate the rest (≤ MaxChars). */
export const minilmBudget = (query) => {
  const budget = MINILM_WINDOW - PAIR_OVERHEAD;
  const q = Math.min(query.normalize('NFKC').length, Math.floor(budget / 2));
  return Math.min(MAX_CHARS, budget - q);
};

// ---- positions ----------------------------------------------------------------------------------------------------
// Offsets are UTF-16 units of the note, which equal its NFKC length here (asserted below), so one number serves both
// the 1,000-character cap (raw) and mMiniLMv2's fit (normalised).
export const POSITIONS = ['start', 'middle', 'end', 'beyond'];
const TIER = {
  // [lo, hi] of the answer's OFFSET, and of the note's TOTAL length; functions of the answer's length L.
  start: { offset: () => [0, 0], total: (L) => [950, 1050] },
  middle: { offset: () => [540, 600], total: (L, s) => [2 * s + L - 60, 2 * s + L + 60] },
  end: { offset: (L) => [880 - L, 960 - L], total: (L, s) => [s + L, s + L] },
  beyond: { offset: () => [1060, 1120], total: (L, s) => [s + L, s + L] },
};

// ---- (1) mentions: other facts by topic, never their content --------------------------------------------------------
/** Topics that carry part of their own fact's answer, so a sentence naming them would half-answer that fact's
 *  questions: 二十四小时药店 ("24-hour" IS the answer), 花生过敏 and Shellfish allergy (name the allergy the questions
 *  ask about), 火锅店排队 (says there is a queue, which the questions ask about). Never mentioned anywhere. */
export const MENTION_EXCLUDED = ['pharm-24h', 'allergy-peanut', 'allergy-shellfish', 'hotpot'];
/** Offsets, within a language's facts in fixture order, of the facts a note mentions. Away from ±1/±2 so a near-duplicate
 *  cluster (adjacent in the fixture) never mentions its own members; each fact is mentioned once per stride. */
const STRIDES = { zh: [7, 18, 29], en: [5, 8, 11], ja: [1, 2, 3] };
const MENTION_TEMPLATES = {
  zh: [(t) => `${t}这件事另外有一条记录,这里不重复。`, (t) => `${t}还要再核实一下,先不写结论。`, (t) => `关于${t},等有空再问清楚。`],
  en: [(t) => `See the separate note on ${t}; it is not repeated here.`, (t) => `Still to double-check: ${t}.`,
    (t) => `Nothing new this week about ${t}.`],
  ja: [(t) => `${t}については別のメモにあるので、ここには書かない。`, (t) => `${t}のことは、もう一度確かめてから書く。`,
    (t) => `${t}の件は、まだ確認していない。`],
};

// ---- (2) neutral household filler: invented, names no fixture subject ----------------------------------------------
const FILLER = {
  zh: [
    '客厅的窗帘下个月要拿去清洗,顺便把挂钩换成金属的。', '冰箱冷冻室结了一层厚霜,周末找时间断电除霜。',
    '书架最上面一层的旧杂志整理出来了,准备送给楼上的邻居。', '电梯下周二上午停运检修,搬重东西要避开那天。',
    '业主群里在讨论楼道灯改成声控的,费用按户平摊。', '家里的备用钥匙放在玄关抽屉的蓝色小盒子里。',
    '卫生间的龙头有点滴漏,已经约了师傅周四来看。', '空调滤网每个季度洗一次,上次是八月底洗的。',
    '厨房抽油烟机的油盒满了,记得倒掉再擦一下。', '相册里缺了去年秋天那次爬山的照片,要从手机里导出来。',
    '周日下午全家一起拼那盒一千片的星空拼图,拼了一半。', '老大想学下围棋,先看几集入门视频。',
    '玄关的鞋柜太满了,旧鞋挑出来一批送人。', '地板上周打过蜡,这周先别用湿拖把。',
    '储物间的圣诞装饰放在最里面的两个纸箱里。', '家里的雨伞只剩一把好的了,出门前看看天气预报。',
    '热水器显示屏偶尔报错,重启一下就好了,先观察。', '老二最近迷上了画恐龙,画纸用得很快。',
    '晚饭后轮流洗碗,这周轮到爸爸。', '周末大扫除的分工:爸爸擦窗户,老大拖地,老二整理玩具。',
    '客厅的吊灯有一个灯泡不亮了,买的时候注意是小螺口的。', '老二的橡皮擦和铅笔总是丢,干脆一次买了一整盒。',
    '外婆在织一条灰色的围巾,说冬至前能织完。', '爷爷每天早上在楼下的小花园打太极拳。',
    '周五晚上是全家的桌游之夜,这周轮到老大选游戏。', '旧报纸攒了一摞,可以拿来包易碎的碗盘。',
    '今年的春联还没买,打算自己写。', '老大在学做蛋炒饭,已经会自己掌握火候了。',
    '冰箱门上的便签纸快用完了,顺手记在购物清单上。', '家里的体重秤没电了,用的是纽扣电池。',
    '书房的台灯换了暖光,晚上看书眼睛舒服多了。', '客厅沙发套上周拆下来洗了,还没装回去。',
    '老二的自然作业要观察豆芽,每天记录长了多高。', '门铃的电池换过了,声音比以前大。',
    '爸爸在研究怎么修那把摇晃的餐椅,买了一小罐木胶。', '外婆寄来一箱自己晒的柿饼,分了一半给邻居。',
    '这个月的家庭开支表做好了,放在共享文件夹里。', '过年要带回老家的礼物清单:茶叶两盒、围巾一条。',
    '窗台上的绿萝长得太长了,剪下几枝插在瓶子里。', '家里的剪刀总是找不到,决定在厨房专门放一把。',
    '老大想要一个新书包,先等旧的真的坏了再说。', '晚上十点以后不要在客厅大声放音乐,楼下有小宝宝。',
    '客厅的时钟慢了五分钟,记得调一下。', '家里的手电筒放在电视柜下面的抽屉里。',
    '周末想把旧玩具摆出来义卖,收入捐给街道的爱心基金。', '厨房的保鲜盒盖子和盒身对不上了,要整理一下配套。',
    '老二这周负责给乌龟换水,换三分之一就行。', '下个月爷爷要来住两周,客房的床单先晒一晒。',
    '家里的打印机缺墨了,黑色墨盒型号写在机器侧面。', '冬天的厚被子从柜子顶上拿下来晒过了。',
    '晚饭少放点盐,爷爷最近血压有点高。', '楼道里堆的纸箱被物业提醒了,周末清掉。',
    '客厅的地毯边角翘起来了,先用双面胶粘住。', '家里的充电线太多太乱,每根都贴上了标签。',
    '周三晚上开家庭会议,讨论下半年的家务分工。', '老二想养一只仓鼠,全家还在商量。',
    '厨房窗户的纱窗破了个小洞,先用胶布补上。', '爸爸的眼镜腿松了,找了个小螺丝刀拧紧。',
    '饮水机该清洗了,上次清洗是三个月前。', '外婆教老二包饺子,包出来的形状千奇百怪。',
    '卧室窗外的晾衣绳松了,找时间重新系紧。', '外婆把旧毛衣拆了线,打算织两副手套。',
    '周末早餐轮流做,这周是煎饼配豆浆。', '客厅墙上的挂画歪了,钉子要往左移两厘米。',
    '老二最近晚上总踢被子,换了一床带扣子的睡袋。', '厨房的刀该磨了,磨刀石在工具箱第二层。',
    '爷爷的老花镜放在茶几上的眼镜盒里。', '这个月家里的零食预算超了,下个月少买点。',
    '周日晚上把下周的晚饭安排写好,贴在冰箱上。', '老大的作文写了家里的那盆多肉,得了好评。',
    '洗手间的镜子容易起雾,买了一瓶防雾喷剂试试。', '家里的工具箱缺一把小号的扳手。',
    '爸爸说今年要把老照片全部扫描存档。', '外婆的收音机坏了,爸爸说周末拆开看看。',
    '客厅的插线板开关有点松,先别插大功率的电器。', '老二在练习系鞋带,每天出门前自己系一次。',
    '楼上邻居装修到月底,白天会比较吵。', '卧室的暖气片摸着不太热,可能要放一下气。',
    '周末想把衣柜换季整理,夏天的衣服收起来。', '书桌的抽屉滑轨坏了,拉的时候要轻一点。',
    '老大和同学约好周六下午在家里做手工。', '厨房的调料瓶贴上了标签,盐和糖再也不会拿错。',
    '外婆种的小葱长出来了,做饭时可以直接掐。', '家里的门垫太旧了,换一块吸水好一点的。',
    '今年的家庭出游照片挑了二十张,准备洗出来。', '晚上睡前全家一起读十分钟书,这周读的是一本童话。',
    '老二的积木零件散落一地,准备按颜色分装。', '客厅的空气净化器滤芯该换了,指示灯已经变红。',
    '周六早上楼里停电两小时,冰箱里别放太多东西。', '爷爷把常用的电话号码抄在一张卡片上,贴在门后。',
    '老大想把卧室的墙刷成浅蓝色,先买一小罐试色。', '厨房水槽下面的柜子有点潮,放了两包干燥剂。',
    '家里的指甲刀放在卫生间的镜柜里。', '周末去外婆家,记得带上那箱橙子。',
    '老二的毛绒玩具太多,挑几只送给表妹。', '客厅茶几的玻璃有道裂纹,先垫了一块桌布。',
    '家里的备用灯泡放在储物间的鞋盒里。', '爸爸最近在学拍照,周末总拿着相机在楼下转。',
    '卧室窗帘的遮光效果不好,早上五点就被照醒。', '老大的钢笔漏墨了,换了一支新的笔囊。',
    '周五晚上吃什么还没定,可能在家包馄饨。', '衣柜顶上的行李箱落了灰,用之前要擦一遍。',
    '老二把彩笔的笔帽都弄丢了,找了个笔筒统一收好。', '客厅的窗户缝漏风,买了密封条准备贴上。',
  ],
  en: [
    'The hallway light flickers whenever the front door slams; the fitting probably needs tightening.',
    'We finally sorted the spare keys: the red tag is the storage room, the blue tag is the side gate.',
    'The freezer needs defrosting before the holidays; the ice is blocking the top drawer.',
    'The eldest is knitting a very long striped scarf and is about halfway through it.',
    'Remember to turn the mattress in the guest room before the relatives come to stay.',
    'The kitchen extractor fan filter is overdue for a wash; soak it in hot soapy suds overnight.',
    'The family photo albums are being scanned, one album per weekend, starting with the oldest.',
    'Someone keeps leaving the lid off the toothpaste.',
    'The garden hose has a split near the tap end and needs a new connector.',
    'The living room rug curls up at one corner; double-sided tape is holding it for now.',
    'The youngest wants a hamster, and the family vote has been postponed until next month.',
    'Board game night is on Fridays, and this week it is the eldest who chooses the game.',
    'The printer ran out of ink again; the cartridge model is written on the side panel.',
    'Grandpa keeps his reading glasses in the case on the coffee table, not in the kitchen drawer.',
    'The squeaky bedroom door hinge just needs a drop of oil.',
    'The shoe rack by the front door is overflowing; the outgrown pairs go to the cousins.',
    'We agreed that screens go off at nine on weeknights.',
    'The winter duvets came down from the top shelf and were aired out on Saturday.',
    'The smoke alarm in the hallway chirped at three in the morning; it takes a 9-volt battery.',
    'The bathroom mirror fogs up badly, so we are trying an anti-fog spray.',
    'The upstairs neighbours are renovating until the end of the month, so mornings will be noisy.',
    'The toolbox is missing a small adjustable spanner; it is on the hardware list.',
    'The dining chair with the wobbly leg has been glued and should be left alone for a day.',
    'The youngest practises tying shoelaces before leaving the house each morning.',
    'The spice jars have new labels, so nobody mixes up the salt and the sugar any more.',
    'The storm shutter on the back window rattles because one latch is loose.',
    'A list of family phone numbers is taped inside the pantry door.',
    'The filter light on the air purifier has turned red, so a replacement is due.',
    'The eldest wants to repaint the bedroom pale green and is testing sample pots first.',
    'Grandma sent a box of homemade dried persimmons, and some of it went to the neighbours.',
    'The drawer runners on the desk are broken, so pull it out gently.',
    'Weekend breakfast rotates around the family; this week it is pancakes.',
    'The doorbell chime was replaced and is now much louder than before.',
    'The household budget spreadsheet for this month is in the shared folder.',
    'There is a slow drip under the kitchen sink; a plumber is coming on Thursday.',
    'The youngest is sorting the toy bricks into tubs by colour.',
    'The torch lives in the drawer under the television, with spare batteries beside it.',
    'The clock in the living room runs five minutes slow and needs resetting.',
    'Dad is learning photography and spends Sunday mornings practising in the courtyard.',
    'The picture frame in the hallway hangs crooked; the nail should move two centimetres left.',
    'The bookshelf in the study is overloaded, and the old magazines are going to the neighbours.',
    'Every charging cable now has a label, so everyone can find their own.',
    'The radiator in the small bedroom barely warms up and may need bleeding.',
    'The eldest is writing a story about the old armchair for a writing contest.',
    'Mum is unravelling an old sweater to knit two pairs of mittens.',
    'Keep the living room quiet after ten; the flat downstairs has a newborn.',
    'The window screen in the kitchen has a small tear; tape will do for now.',
    'We are planning a toy sale on the front steps, with the proceeds going to the neighbourhood fund.',
    'The blender lid cracked, so smoothies are on hold until a new one arrives.',
    'The guest towels are in the linen cupboard on the second shelf.',
    'The eldest and a friend are building a model rocket on Saturday afternoon.',
    'Only one umbrella in the stand still works; check the forecast before heading out.',
    'The holiday decorations are in the two boxes at the very back of the storage room.',
    'The kitchen knives need sharpening; the whetstone is in the second tray of the toolbox.',
    'We read together for ten minutes before bed; this week it is a collection of fables.',
    'The sofa covers were washed last week and still need to go back on.',
    'The wardrobe needs its seasonal swap: summer clothes into the boxes under the bed.',
    'A draught comes in around the living room window, so sealing strip is on the list.',
  ],
  ja: [
    '玄関の電球が切れかけているので、週末に取り替える。', '冷凍庫に霜がたまってきたので、連休の前に霜取りをする。',
    '本棚の一番上の古い雑誌は、上の階のお隣さんに譲ることにした。', '合鍵は玄関の引き出しの青い小箱に入れてある。',
    '台所の換気扇のフィルターを今月中に洗うこと。', '二番目の子が恐竜の絵に夢中で、画用紙がすぐなくなる。',
    'おじいちゃんの老眼鏡は、居間のテーブルの眼鏡ケースにある。', '寝室のカーテンは遮光が弱く、朝早くから明るくなる。',
    '洗面所の鏡がすぐ曇るので、曇り止めスプレーを試してみる。', '金曜の夜は家族でボードゲームをする日で、今週は長女が選ぶ番。',
    '上の階の部屋が月末まで改装工事なので、昼間は少しうるさい。', '物置のクリスマスの飾りは、奥の段ボール二箱に入っている。',
    '母が古いセーターをほどいて、手袋を二組編むつもりらしい。', 'プリンターのインクが切れた。型番は本体の横に書いてある。',
    '居間の時計が五分遅れているので、合わせておくこと。', '懐中電灯はテレビ台の下の引き出しに入れてある。',
    '今月の家計簿は共有フォルダにまとめておいた。', '台所の包丁を研がないといけない。砥石は工具箱の二段目にある。',
    '冬用の厚い布団を押し入れから出して、土曜日に干した。', '玄関の靴箱がいっぱいなので、小さくなった靴はいとこに譲る。',
    '食卓のぐらぐらする椅子は接着剤で直したので、一日さわらないこと。', '父は最近写真に凝っていて、日曜の朝はよく中庭で練習している。',
    '調味料の瓶にラベルを貼ったので、塩と砂糖を間違えなくなった。', '寝る前に家族で十分だけ本を読む。今週は昔話の本。',
    '居間の空気清浄機のフィルター交換ランプが赤くなった。', '二番目の子は毎朝、出かける前に自分で靴ひもを結ぶ練習をしている。',
    '祖母から手作りの干し柿が一箱届いたので、半分をお隣に分けた。', '廊下の額縁が傾いているので、釘を左に二センチずらす。',
    '台所の網戸に小さな穴があいたので、とりあえずテープでふさいだ。', '夜十時以降は居間で大きな音を出さないこと。下の階に赤ちゃんがいる。',
    '充電ケーブルが多すぎるので、一本ずつ名前のシールを貼った。', '長女は寝室の壁を薄い青に塗りたいらしく、まず試し塗りの小さな缶を買う。',
    '机の引き出しのレールが壊れているので、そっと引くこと。', '週末の朝ごはんは交代で作る。今週はホットケーキ。',
    '洗面所の下の棚が少し湿っぽいので、除湿剤を二つ置いた。', '二番目の子のブロックを色ごとに箱に分けて片付けた。',
    '母は古い家族写真を全部スキャンして残すと言っている。', '玄関のチャイムを新しくしたら、前よりずっと音が大きくなった。',
    '玄関マットが古くなったので、吸水のいいものに替える。', '工具箱に小さいモンキーレンチがないので、買い物リストに書いておく。',
    '祖父のラジオが壊れたので、父が週末に分解してみるそうだ。', '物置に湿気がこもらないよう、ときどき扉を開けておく。',
    '衣替えをして、夏物の服は衣装ケースにしまった。', '居間の窓のすき間から風が入るので、すき間テープを貼るつもりだ。',
    '長女は友だちと土曜の午後に家で工作をする約束をしている。', '祖父は毎朝、下の小さな庭で体操をしている。',
  ],
};

/** Every fixture fact's SUBJECT, in the words a question about it could use — zh, en, ja. A filler sentence containing
 *  any of these could be ABOUT a fixture fact, so the build fails on it. English entries match whole words, case-blind;
 *  CJK entries match as substrings. Deliberately broad: it also bars the business-hours, price and booking vocabulary
 *  the questions are made of, so the filler reads as a diary rather than as a second set of answers. */
export const SUBJECT_TERMS = {
  zh: ['市场', '集市', '农贸', '菜市', '东门', '夜市', '西街', '摆摊', '鱼市', '海港', '码头', '博物馆', '门票', '票价',
    '图书馆', '河畔', '河边', '河滨', '游泳', '泳池', '南湖', '北区', '城北', '药店', '药房', '退烧', '发烧', '护照',
    '签证', '身份证', '证件', '派出所', '学校', '小学', '放学', '校门', '迟到', '接孩子', '送孩子', '校餐', '午饭', '午餐',
    '过敏', '花生', '海鲜', '甲壳', '虾', '蟹', '急救', '车险', '保险', '年检', '验车', '车辆', '车子', '面馆', '牛肉面',
    '鸡蛋面', '番茄', '拉面', '寿司', '火锅', '海边', '快车', '慢车', '火车', '车站', '酒店', '民宿', '客栈', '取消',
    '退订', '改期', '垃圾', '厨余', '回收', '牙', '矫正', '钢琴', '课', '学期', '学费', '健身', '会员', '续费', '猫',
    '疫苗', '预防针', '柠檬', '浇水', '阳台', '露台', '电费', '水费', '燃气', '煤气', '扣款', '工资卡', '宽带', '网速',
    '合同', '停车', '车位', '地库', '访客', '单车', '自行车', '骑', '机场', '打车', '出租', '巴士', '公交', '医院', '儿科',
    '专家号', '放号', '挂号', '银行', '邮局', '包裹', '快递', '生日', '诞辰', '蛋糕', '农历', '阴历', '纪念日', '结婚',
    '排队', '取号', '温泉', '旅馆', '便利店', '夏令营', '暑假', '报名', '流感', '诊所', '滑雪', '雪具', '教练',
    '动物园', '干洗', '洗衣', '大衣', '外套', '保姆', '阿姨', '钟点工', '电影', '影院', '商场', '半价', '营业', '开门',
    '关门', '收摊', '打烊', '预约', '订座', '订位', '家长A', '家长B', '大孩子', '小的那个'],
  en: ['market', 'markets', 'harbor', 'harbour', 'dock', 'docks', 'museum', 'ticket', 'tickets', 'admission', 'library',
    'riverside', 'pool', 'swim', 'swimming', 'pharmacy', 'fever', 'passport', 'visa', 'ID', 'school', 'lunch', 'meals',
    'allergy', 'allergic', 'peanut', 'shellfish', 'shrimp', 'crab', 'crustaceans', 'seafood', 'fish', 'insurance',
    'inspection', 'car', 'vehicle', 'noodle', 'noodles', 'sushi', 'ramen', 'hotpot', 'train', 'coast', 'seaside',
    'hotel', 'guesthouse', 'inn', 'cancel', 'cancellation', 'refund', 'reschedule', 'trash', 'recyclable', 'recyclables',
    'garbage', 'dentist', 'braces', 'piano', 'lesson', 'lessons', 'class', 'term', 'gym', 'membership', 'fitness', 'cat',
    'vaccine', 'vaccination', 'vaccinations', 'rabies', 'lemon', 'watering', 'water', 'balcony', 'electricity', 'gas',
    'bill', 'salary', 'internet', 'broadband', 'Mbps', 'contract', 'parking', 'visitor', 'bike', 'bicycle', 'ride',
    'airport', 'taxi', 'cab', 'bus', 'shuttle', 'terminal', 'hospital', 'pediatric', 'specialist', 'appointment', 'bank',
    'post', 'parcel', 'parcels', 'package', 'packages', 'birthday', 'cake', 'lunar', 'anniversary', 'wedding', 'onsen',
    'spring', 'ryokan', 'convenience', 'barcode', 'camp', 'registration', 'register', 'flu', 'influenza', 'clinic',
    'ski', 'instructor', 'zoo', 'laundry', 'dry', 'cleaner', 'coat', 'babysitter', 'sitter', 'cinema', 'movie', 'mall',
    'half', 'open', 'opens', 'close', 'closes', 'closed', 'hours', 'fare', 'fee', 'price', 'cost', 'costs', 'yuan', 'book',
    'booking', 'reserve', 'Parent'],
  ja: ['市場', '東門', 'ナイトマーケット', '西通り', '漁港', '魚', '博物館', '入場料', 'チケット', '図書館', '川沿い', 'プール',
    '水泳', '薬局', '解熱', 'パスポート', 'ビザ', '身分証', '小学校', '下校', '学校', '遅刻', '給食', 'アレルギー', '甲殻',
    '発疹', '保険', '車検', '車', '麺', '寿司', 'ラーメン', '替え玉', '火鍋', '整理券', '列車', '海辺', 'ホテル', '民宿',
    '旅館', 'キャンセル', 'ごみ', 'リサイクル', '歯', '矯正', 'ピアノ', 'レッスン', '教室', 'ジム', '会員', '猫', '予防接種',
    'ワクチン', 'レモン', '水やり', 'ベランダ', '電気代', '水道', 'ガス', 'インターネット', '契約', '駐車', '自転車', '空港',
    'タクシー', 'バス', '病院', '小児', '銀行', '郵便', '小包', '荷物', '宅配', '誕生日', '旧暦', '記念日', '結婚', '温泉',
    'コンビニ', 'バーコード', 'サマーキャンプ', '申し込み', 'インフルエンザ', 'スキー', 'インストラクター', '動物園',
    'クリーニング', 'コート', 'ベビーシッター', '映画', 'モール', '半額', '営業', '開店', '閉まる', '料金', '無料', '予約',
    '下の子', '上の子', '親A', '親B'],
};

// ---- helpers -------------------------------------------------------------------------------------------------------
const mulberry32 = (a) => () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const seedOf = (s) => { let h = 0x811c9dc5; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const shuffled = (xs, seed) => {
  const a = [...xs], rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
// The same language test recall-questions.mjs uses: kana marks Japanese, hanzi without kana Chinese, else English.
export const languageOf = (f) => (/[぀-ヿ]/.test(`${f.topic} ${f.content}`) ? 'ja' : /[一-鿿]/.test(`${f.topic} ${f.content}`) ? 'zh' : 'en');
const JOIN = { zh: '', ja: '', en: ' ' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The subject terms a text contains, in its language's matching rule. */
export const subjectHits = (text, lang) => SUBJECT_TERMS[lang].filter((t) => (lang === 'en'
  ? new RegExp(`\\b${escapeRe(t)}\\b`, t === 'ID' || t === 'Mbps' || t === 'Parent' ? '' : 'i').test(text)
  : text.includes(t)));

/** Fill a run of sentences to a length inside [lo, hi], taking pool sentences in order, skipping any that would pass
 *  `hi`, and inserting each forced sentence once the run has reached its planned length. */
const fill = (pool, cursor, lo, hi, join, forced = []) => {
  const parts = [];
  let len = 0;
  const pending = [...forced].sort((a, b) => a.at - b.at);
  const add = (s) => { len += (parts.length ? join.length : 0) + s.length; parts.push(s); };
  const cost = (s) => (parts.length ? join.length : 0) + s.length;
  let guard = 0;
  while (len < lo || pending.length) {
    if (++guard > 10 * pool.length) throw new Error(`cannot fill [${lo}, ${hi}] from a pool of ${pool.length}`);
    if (pending.length && len >= pending[0].at && len + cost(pending[0].text) <= hi) { add(pending.shift().text); continue; }
    if (len >= lo) { // only forced sentences are left, and they have not been placed: place them now if they fit
      if (pending.length && len + cost(pending[0].text) <= hi) { add(pending.shift().text); continue; }
      throw new Error(`a forced sentence does not fit in [${lo}, ${hi}]`);
    }
    // Never wrap: a wrapped pool would repeat a sentence inside one note.
    if (cursor.i >= pool.length) throw new Error(`the filler pool (${pool.length}) ran out filling [${lo}, ${hi}]`);
    const s = pool[cursor.i];
    cursor.i++;
    if (len + cost(s) <= hi) add(s);
  }
  return { text: parts.join(join), len };
};

// ---- the build -----------------------------------------------------------------------------------------------------
/** The fixture's facts by language, each list in fixture order. */
export const byLanguage = (facts) => {
  const byLang = { zh: [], en: [], ja: [] };
  for (const f of facts) byLang[languageOf(f)].push(f);
  return byLang;
};

/** fact id → the other facts its note names by topic: up to three same-language facts, at fixed strides through the
 *  language's facts in fixture order (never itself, never a MENTION_EXCLUDED topic). */
export const mentionsOf = (facts) => {
  const mentions = new Map();
  for (const [lang, group] of Object.entries(byLanguage(facts))) {
    group.forEach((f, i) => {
      const ms = STRIDES[lang].map((s, k) => ({ other: group[(i + s) % group.length], k }))
        .filter(({ other }) => other.id !== f.id && !MENTION_EXCLUDED.includes(other.id))
        .map(({ other, k }) => ({ id: other.id, text: MENTION_TEMPLATES[lang][k](other.topic) }));
      mentions.set(f.id, ms);
    });
  }
  return mentions;
};

/** ONE fact's long note: its original content (the answer) at `pos`, padded with neutral filler drawn from the fact's own
 *  shuffle of its language's pool and with `ms` — the mentions `mentionsOf` gives it. Returns the note and the answer's
 *  offset. Pure: the same fact, position and mentions give the same note, in any fixture that builds it. */
export function longNote(f, pos, ms) {
  const lang = languageOf(f);
  const C = f.content;
  const L = C.length;
  const join = JOIN[lang];
  const pool = shuffled(FILLER[lang], seedOf(f.id));
  const cursor = { i: 0 };
  const [olo, ohi] = TIER[pos].offset(L);

  // Mentions are spread over the note: in the padding BEFORE the answer for end/beyond, AFTER it for start, and
  // split for middle (the first before, the rest after), each placed at an even fraction of its run.
  const place = (list, runLo) => list.map((m, k) => ({ text: m.text, at: Math.floor(((k + 0.5) / list.length) * runLo * 0.9) }));
  let before = { text: '', len: 0 }, after = { text: '', len: 0 };
  let offset;
  if (pos === 'start') {
    offset = 0;
    const [tlo, thi] = TIER.start.total(L);
    const lo = tlo - L - join.length, hi = thi - L - join.length;
    after = fill(pool, cursor, lo, hi, join, place(ms, lo));
  } else {
    const beforeMs = pos === 'middle' ? ms.slice(0, 1) : ms;
    const afterMs = pos === 'middle' ? ms.slice(1) : [];
    // The run BEFORE the answer ends with a separator, so the answer's offset is the run's length plus it.
    before = fill(pool, cursor, olo - join.length, ohi - join.length, join, place(beforeMs, olo - join.length));
    offset = before.len + (before.len ? join.length : 0);
    if (pos === 'middle') {
      const [tlo, thi] = TIER.middle.total(L, offset);
      const lo = tlo - offset - L - join.length, hi = thi - offset - L - join.length;
      after = fill(pool, cursor, lo, hi, join, place(afterMs, lo));
    }
  }
  return { note: [before.text, C, after.text].filter(Boolean).join(join), offset };
}

/** The long fixture, from the bilingual fixture's parsed JSON and its raw bytes. Pure: same input, same output. */
export function buildLongFixture(base, baseBytes) {
  const facts = base.facts;
  const byLang = byLanguage(facts);

  // Position: cycle start → middle → end → beyond through each language's facts in fixture order.
  const position = new Map();
  for (const group of Object.values(byLang)) group.forEach((f, i) => position.set(f.id, POSITIONS[i % POSITIONS.length]));

  // Mentions: each note names up to three other same-language facts, by topic, at fixed strides.
  const mentions = mentionsOf(facts);

  const out = facts.map((f) => {
    const pos = position.get(f.id);
    const ms = mentions.get(f.id);
    const { note, offset } = longNote(f, pos, ms);
    return {
      id: f.id, kind: f.kind, topic: f.topic, content: note, questions: f.questions,
      position: pos, answer: { text: f.content, offset, length: f.content.length },
      mentions: ms.map((m) => m.id),
    };
  });

  const fixture = {
    generatedBy: 'devtools/scripts/judge-bench-long-fixture.mjs',
    derivedFrom: { file: 'devtools/fixtures/recall-bilingual.json', sha256: crypto.createHash('sha256').update(baseBytes).digest('hex') },
    sets: base.sets,
    positions: {
      start: 'the answer at offset 0 — read by every reranker',
      middle: 'the answer at offset 540–600 with about as much text after it — past mMiniLMv2\'s cut (≤ 490 characters) for every question, inside the 1,000-character cap',
      end: 'the answer is the last text of an 880–960-character note — past mMiniLMv2\'s cut, inside the 1,000-character cap',
      beyond: 'the answer at offset 1,060–1,120, the last text of the note — past the 1,000-character cap too',
    },
    mentionExcluded: MENTION_EXCLUDED,
    facts: out,
  };
  validate(base, fixture);
  return fixture;
}

/** Every property the design claims, checked on the built fixture; throws on the first failure. */
export function validate(base, fixture) {
  const fail = (m) => { throw new Error(`long fixture: ${m}`); };
  const baseById = new Map(base.facts.map((f) => [f.id, f]));
  if (fixture.facts.length !== base.facts.length) fail(`${fixture.facts.length} facts, the base has ${base.facts.length}`);
  const notes = fixture.facts.map((f) => f.content);
  for (const f of fixture.facts) {
    const b = baseById.get(f.id);
    if (!b) fail(`${f.id} is not in the base fixture`);
    if (f.kind !== b.kind || f.topic !== b.topic) fail(`${f.id}: kind or topic changed`);
    if (JSON.stringify(f.questions) !== JSON.stringify(b.questions)) fail(`${f.id}: questions changed`);
    if (f.answer.text !== b.content) fail(`${f.id}: the answer is not the base content`);
    // The answer occurs exactly once in its own note, at its declared offset …
    if (f.content.indexOf(b.content) !== f.answer.offset || f.content.lastIndexOf(b.content) !== f.answer.offset)
      fail(`${f.id}: the answer is not exactly once at offset ${f.answer.offset}`);
    // … and in NO other note: otherwise that note would also answer this fact's questions.
    const elsewhere = fixture.facts.filter((g) => g.id !== f.id && g.content.includes(b.content)).map((g) => g.id);
    if (elsewhere.length) fail(`${f.id}: its answer also occurs in ${elsewhere.join(', ')}`);
    // Offsets hold under NFKC too, so the same number is mMiniLMv2's (normalised) and the cap's (raw).
    if (f.content.normalize('NFKC').length !== f.content.length) fail(`${f.id}: NFKC changes the note's length`);
    const L = b.content.length, s = f.answer.offset, N = f.content.length;
    const [olo, ohi] = TIER[f.position].offset(L);
    if (s < olo || s > ohi) fail(`${f.id}: offset ${s} outside ${f.position}'s [${olo}, ${ohi}]`);
    const [tlo, thi] = TIER[f.position].total(L, s);
    if (N < tlo || N > thi) fail(`${f.id}: length ${N} outside ${f.position}'s [${tlo}, ${thi}]`);
    // The cut, per question: hidden from mMiniLMv2 for every question except at `start`, where it is whole.
    for (const q of Object.values(f.questions)) {
      const B = minilmBudget(q);
      if (f.position === 'start' ? s + L > B : s < B) fail(`${f.id}: mMiniLMv2 reads ${B} characters for "${q}", answer at ${s}–${s + L}`);
    }
    if (f.position === 'beyond' ? s < MAX_CHARS : s + L > MAX_CHARS) fail(`${f.id}: the 1,000-character cap and the ${f.position} position disagree`);
    // Mentions: never itself, never an answer-bearing topic, never the mentioned fact's content.
    for (const id of f.mentions) {
      if (id === f.id) fail(`${f.id} mentions itself`);
      if (MENTION_EXCLUDED.includes(id)) fail(`${f.id} mentions ${id}, whose topic carries part of its answer`);
      if (!f.content.includes(baseById.get(id).topic)) fail(`${f.id}: mention of ${id} is not in the note`);
    }
  }
  validatePools(fail);
  // Positions are balanced: 15 each, and within each language equal counts.
  for (const p of POSITIONS) {
    const n = fixture.facts.filter((f) => f.position === p).length;
    if (n !== fixture.facts.length / POSITIONS.length) fail(`${n} facts at ${p}`);
  }
  // Every fact's content is distinct from every note but its own — including as a note's whole text.
  if (new Set(notes).size !== notes.length) fail('two notes are identical');
}

/** The filler names no fixture subject — checked on the POOL, so a sentence nobody drew is checked too — and neither
 *  does a mention template's own wording. Shared by every fixture built from these pools. */
export function validatePools(fail) {
  for (const [lang, pool] of Object.entries(FILLER)) {
    const dup = pool.find((s, i) => pool.indexOf(s) !== i);
    if (dup) fail(`duplicate ${lang} filler sentence: ${dup}`);
    for (const s of pool) {
      const hits = subjectHits(s, lang);
      if (hits.length) fail(`${lang} filler names a fixture subject (${hits.join(', ')}): ${s}`);
      if (s.normalize('NFKC').length !== s.length) fail(`${lang} filler changes length under NFKC: ${s}`);
    }
    for (const t of MENTION_TEMPLATES[lang]) {
      const hits = subjectHits(t(''), lang);
      if (hits.length) fail(`${lang} mention template names a fixture subject (${hits.join(', ')})`);
    }
  }
}

export const serialise = (fixture) => JSON.stringify(fixture, null, 2) + '\n';
export const readBase = () => {
  const bytes = fs.readFileSync(BASE_FIXTURE);
  return { base: JSON.parse(bytes.toString('utf8')), bytes };
};
/** The bytes this generator writes today — what `judge-bench --fixture=long` compares the committed file against. */
export const expectedLongBytes = () => { const { base, bytes } = readBase(); return Buffer.from(serialise(buildLongFixture(base, bytes)), 'utf8'); };

// ---- the report: where each position lands ------------------------------------------------------------------------
const summarise = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? `${s[0]}–${s[s.length - 1]} (median ${s[Math.floor((s.length - 1) / 2)]})` : '—';
};
function printCharReport(fixture) {
  console.log('\nposition  n   answer offset (chars)          answer end (chars)             note length (chars)            mMiniLMv2 reads, per question   BGE/LAMAR read');
  for (const p of POSITIONS) {
    const fs_ = fixture.facts.filter((f) => f.position === p);
    const budgets = fs_.flatMap((f) => Object.values(f.questions).map(minilmBudget));
    console.log(`${p.padEnd(9)} ${String(fs_.length).padEnd(3)} ${summarise(fs_.map((f) => f.answer.offset)).padEnd(30)} `
      + `${summarise(fs_.map((f) => f.answer.offset + f.answer.length)).padEnd(30)} ${summarise(fs_.map((f) => f.content.length)).padEnd(30)} `
      + `${summarise(budgets).padEnd(31)} ${MAX_CHARS}`);
  }
}

// ---- --measure: tokens, on dedicated CPU llama-servers ------------------------------------------------------------
/** Tokenize every note of `fixture` (written at `fixtureFile`) on dedicated CPU llama-servers and report, per position
 *  in `positions`, where each answer lands in tokens; the record goes to `dir`, a gitignored scratch folder. Shared with
 *  the mixed fixture's generator (docs/judge-bench.md Run 9). */
export async function measure(fixture, { fixtureFile = LONG_FIXTURE, positions = POSITIONS,
  dir = path.join(repo, 'devtools', '_judge-bench-long') } = {}) {
  const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt ?? ''}`).slice(name.length + 3);
  const resources = arg('resources', '');
  if (!resources) throw new Error('--measure needs --resources=<a folder holding llama-cpp/ and gguf/> (never a household data folder)');
  const res = path.resolve(resources);
  const exe = path.join(res, 'llama-cpp', 'llama-server.exe');
  const port0 = Number(arg('port', '6250'));
  const catalogue = fs.readFileSync(path.join(repo, 'src', 'server', 'Gatherlight.Platform', 'Agent', 'Llm', 'Services', 'GgufCatalog.cs'), 'utf8');
  const models = [
    { key: 'minilm', id: 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0', normalise: true },
    { key: 'bge', id: 'bge-reranker-v2-m3-Q5_K_M', normalise: false },
  ];
  const out = { date: new Date().toISOString(), fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'), models: {}, notes: {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const [i, m] of models.entries()) {
    const file = path.join(res, 'gguf', `${m.id}.gguf`);
    const pinned = (catalogue.match(new RegExp(`"${m.id.replaceAll('.', '\\.')}\\.gguf",\\s*"([0-9a-f]{64})"`)) ?? [])[1];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== pinned) throw new Error(`${file} is not the catalogue's pinned file (${actual} ≠ ${pinned})`);
    const port = port0 + i;
    // CPU on purpose: tokenizing needs no GPU, and it leaves the GPU to whatever else is running.
    const child = spawn(exe, ['-m', file, '--port', String(port), '--host', '127.0.0.1', '--reranking', '--n-gpu-layers', '0',
      '-c', '4096', '-b', '4096', '-ub', '4096'], { stdio: 'ignore', windowsHide: true });
    console.log(`  ${m.id}: llama-server pid ${child.pid} on ${port} (sha256 ${actual.slice(0, 12)}…, the pinned file)`);
    const base = `http://127.0.0.1:${port}`;
    try {
      let up = false;
      for (let t = 0; t < 480 && !up; t++) { try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(250); }
      if (!up) throw new Error(`llama-server on ${port} did not become healthy`);
      const tok = async (content) => {
        const r = await fetch(`${base}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, add_special: false }) });
        if (!r.ok) throw new Error(`tokenize ${r.status}: ${await r.text()}`);
        return (await r.json()).tokens.length;
      };
      const prep = (s) => (m.normalise ? s.normalize('NFKC') : s);
      out.models[m.key] = { id: m.id, sha256: actual, pid: child.pid };
      let maxPair = 0, maxPairAt = null;
      for (const f of fixture.facts) {
        const note = prep(f.content);
        const s = f.answer.offset, e = s + f.answer.length;
        const rec = out.notes[f.id] ??= { position: f.position, chars: { offset: s, end: e, total: f.content.length } };
        rec[m.key] = { offset: await tok(note.slice(0, s)), end: await tok(note.slice(0, e)), total: await tok(note) };
      }
      if (m.key === 'minilm') {
        // What the product actually SENDS mMiniLMv2 for every (question, candidate) pair of the run: the question fitted,
        // each candidate cut to the budget the question leaves. 0 pairs over 512 tokens is the fit holding on this corpus.
        // ~6,000 small /tokenize requests: on Windows each leaves a TIME_WAIT socket for ~2 minutes, and this machine's
        // dynamic port range can start at 1024 — so let them drain before binding a server on a nearby port.
        const qs = fixture.facts.flatMap((f) => Object.values(f.questions));
        const qTok = new Map();
        for (const q of qs) if (!qTok.has(q)) qTok.set(q, await tok(q.normalize('NFKC')));
        const cutTok = new Map();
        let over = 0, pairs = 0;
        for (const q of qs) {
          const B = minilmBudget(q);
          for (const f of fixture.facts) {
            const key = `${f.id}|${B}`;
            if (!cutTok.has(key)) cutTok.set(key, await tok(f.content.normalize('NFKC').slice(0, B)));
            const pair = qTok.get(q) + cutTok.get(key) + 4;
            pairs++;
            if (pair > MINILM_WINDOW) over++;
            if (pair > maxPair) { maxPair = pair; maxPairAt = { question: q, fact: f.id, budget: B }; }
          }
        }
        out.models[m.key].pairs = { total: pairs, over512: over, maxTokens: maxPair, maxAt: maxPairAt };
        console.log(`  mMiniLMv2, every (question, candidate) pair as the fit sends it: ${pairs} pairs, ${over} over ${MINILM_WINDOW} tokens, largest ${maxPair}`);
      }
    } finally {
      child.kill();
      await sleep(1500);
    }
  }
  console.log('\nposition  answer offset, tokens (mMiniLMv2 · BGE)                   answer end, tokens (mMiniLMv2 · BGE)                    note, tokens (mMiniLMv2 · BGE)');
  for (const p of positions) {
    const rs = Object.values(out.notes).filter((r) => r.position === p);
    const col = (k, f) => summarise(rs.map((r) => r[k][f]));
    console.log(`${p.padEnd(9)} ${`${col('minilm', 'offset')} · ${col('bge', 'offset')}`.padEnd(57)} ${`${col('minilm', 'end')} · ${col('bge', 'end')}`.padEnd(55)} ${col('minilm', 'total')} · ${col('bge', 'total')}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, `lengths-${out.date.replace(/:/g, '')}.json`);
  fs.writeFileSync(record, JSON.stringify(out, null, 2));
  console.log(`\nlengths: ${path.relative(repo, record).split(path.sep).join('/')}`);
}

// ---- CLI -----------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const want = expectedLongBytes();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(LONG_FIXTURE) ? fs.readFileSync(LONG_FIXTURE) : Buffer.alloc(0);
    if (!have.equals(want)) { console.error('recall-bilingual-long.json is not what the generator writes — re-run it'); process.exit(1); }
    console.log('recall-bilingual-long.json matches the generator');
  } else if (!process.argv.includes('--measure')) {
    fs.writeFileSync(LONG_FIXTURE, want);
    console.log(`wrote ${path.relative(repo, LONG_FIXTURE).split(path.sep).join('/')} (sha256 ${crypto.createHash('sha256').update(want).digest('hex')})`);
  }
  const fixture = JSON.parse(want.toString('utf8'));
  printCharReport(fixture);
  if (process.argv.includes('--measure')) await measure(fixture);
}
