# judge-bench — what each way of judging a recall is worth

Measured with `node devtools/dev.mjs judge-bench` on `devtools/fixtures/recall-bilingual.json` (60 invented
facts incl. near-duplicate clusters; four questions each: same / cross / third language / code-switched),
`limit 8`, one snapshot per arm. Date, claude CLI version, and the exact command go in each run's heading.

The 语义 (semantic) layer was OFF in every arm below — this run measures 判断 (the judge) alone. Cross-language
recall therefore had no semantic channel to bridge languages; only the lexical floor (公式) and the judge's own
reasoning over candidate text carried it, which is why every arm's cross/third-language numbers stay far below
its same-language numbers (see "What it does NOT say").

## Run 1 — the Claude judge (2026-09-23, claude 2.1.280)

**Command**

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,formula2,topic,content,content2,contentonly,fuse \
  > devtools/_judge-bench-cli.txt 2>&1

node devtools/dev.mjs judge-bench --report-only=devtools/_judge-bench/results-2026-09-23T091740.681Z.json \
  > devtools/_judge-bench-cli-reanalysed.txt 2>&1
```

**Seed** — reused (not reseeded): created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`,
fixture sha256 `9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555` (the run's own fixture hash
matches it — same fixture). The seed's own app HEAD/version are unrecorded (the seed predates that field); this
run's app HEAD is `81e3ddd` (v1.2.0). Order seed **12345** (240 queries, 0 same-fact adjacencies), concurrency
**7 arms in parallel**, latency sample 12 queries. Formula positions digest **`f661eb6a056e`** (240 queries, 60
facts) — the precondition for treating every arm as having started from the same graph.

### Accuracy — the four sets and `all`

```
== same ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    60     0       0         42/60     54/60     0.769   301            
公式 · no verification · A/A twin                      60   0    60     0       0         42/60     54/60     0.769   310            +0 / +0 / +0.000
Claude judge · topic only                              60   0    60     60      42        53/60     57/60     0.912   14249          +11 / +3 / +0.143
Claude judge · topic — content · partition             60   0    60     59      56        57/60     57/60     0.950   14434          +15 / +3 / +0.181
Claude judge · topic — content · partition · A/A twin  60   0    60     60      57        57/60     57/60     0.950   14483          +15 / +3 / +0.181
Claude judge · content only · partition                60   0    60     60      57        57/60     57/60     0.950   14357          +15 / +3 / +0.181
Claude judge · topic — content · fuse                  60   0    60     59      56        28/60     56/60     0.656   13998          -14 / +2 / -0.113

== cross ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    60     0       0         1/60      6/60      0.042   369            
公式 · no verification · A/A twin                      60   0    60     0       0         1/60      6/60      0.042   368            +0 / +0 / +0.000
Claude judge · topic only                              60   0    60     60      9         9/60      9/60      0.150   15500          +8 / +3 / +0.108
Claude judge · topic — content · partition             60   0    60     60      11        11/60     11/60     0.183   15540          +10 / +5 / +0.142
Claude judge · topic — content · partition · A/A twin  60   0    60     60      9         9/60      9/60      0.150   15357          +8 / +3 / +0.108
Claude judge · content only · partition                60   0    60     60      9         9/60      9/60      0.150   15880          +8 / +3 / +0.108
Claude judge · topic — content · fuse                  60   0    60     60      9         1/60      7/60      0.042   15671          +0 / +1 / +0.001

== third ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    55     0       0         1/60      18/60     0.119   318            
公式 · no verification · A/A twin                      60   0    55     0       0         1/60      18/60     0.119   319            +0 / +0 / +0.000
Claude judge · topic only                              60   0    55     54      12        12/60     16/60     0.233   13165          +11 / -2 / +0.114
Claude judge · topic — content · partition             60   0    55     55      16        16/60     16/60     0.267   13768          +15 / -2 / +0.147
Claude judge · topic — content · partition · A/A twin  60   0    55     55      16        16/60     16/60     0.267   14173          +15 / -2 / +0.147
Claude judge · content only · partition                60   0    55     54      16        16/60     16/60     0.267   13757          +15 / -2 / +0.147
Claude judge · topic — content · fuse                  60   0    55     55      16        1/60      16/60     0.138   14642          +0 / -2 / +0.018

== mixed ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    59     0       0         35/60     47/60     0.657   359            
公式 · no verification · A/A twin                      60   0    59     0       0         35/60     47/60     0.657   361            +0 / +0 / +0.000
Claude judge · topic only                              60   0    59     59      39        46/60     49/60     0.792   14634          +11 / +2 / +0.135
Claude judge · topic — content · partition             60   0    59     57      46        48/60     49/60     0.808   15065          +13 / +2 / +0.151
Claude judge · topic — content · partition · A/A twin  60   0    59     59      48        48/60     49/60     0.808   14564          +13 / +2 / +0.151
Claude judge · content only · partition                60   0    59     59      48        48/60     49/60     0.808   14852          +13 / +2 / +0.151
Claude judge · topic — content · fuse                  60   0    59     59      48        33/60     49/60     0.678   14526          -2 / +2 / +0.021

== all ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             240  0    234    0       0         79/240    125/240   0.397   337            
公式 · no verification · A/A twin                      240  0    234    0       0         79/240    125/240   0.397   339            +0 / +0 / +0.000
Claude judge · topic only                              240  0    234    233     102       120/240   131/240   0.522   14387          +41 / +6 / +0.125
Claude judge · topic — content · partition             240  0    234    231     129       132/240   133/240   0.552   14702          +53 / +8 / +0.155
Claude judge · topic — content · partition · A/A twin  240  0    234    234     130       130/240   131/240   0.544   14644          +51 / +6 / +0.147
Claude judge · content only · partition                240  0    234    233     130       130/240   131/240   0.544   14712          +51 / +6 / +0.147
Claude judge · topic — content · fuse                  240  0    234    233     129       63/240    128/240   0.378   14709          -16 / +3 / -0.018
```

### Paired vs `content` — McNemar exact, per query

`b` = content hit & arm miss, `c` = content miss & arm hit. Interval = Agresti–Min 95% for the net rate
`(c − b) / pairs`; equivalence needs the whole interval inside ±3pp.

```
  top-1:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)             all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                         same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  公式 · no verification · A/A twin                      all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                         same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  Claude judge · topic only                              all     240    12/0     <0.001  -12 (-5.0pp)     [-7.8, -2.1]pp      no          YES (arm worse)
                                                         same    60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · content only · partition                all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · fuse                  all     240    69/0     <0.001  -69 (-28.8pp)    [-34.3, -22.8]pp    no          YES (arm worse)
                                                         same    60     29/0     <0.001  -29 (-48.3pp)    [-59.6, -34.0]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
  found@8:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)             all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                         same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                         cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                         third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  公式 · no verification · A/A twin                      all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                         same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                         cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                         third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  Claude judge · topic only                              all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · content only · partition                all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · fuse                  all     240    5/0      0.063   -5 (-2.1pp)      [-4.0, -0.1]pp      no          no
                                                         same    60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
                                                         cross   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
```

### Paired vs `formula` — McNemar exact, per query

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
  top-1:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                      all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic only                              all     240    4/45     <0.001  +41 (+17.1pp)    [+11.6, +22.3]pp    no          YES (arm better)
                                                         same    60     3/14     0.013   +11 (+18.3pp)    [+5.1, +30.4]pp     —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/11     <0.001  +11 (+18.3pp)    [+7.7, +27.8]pp     —           
                                                         mixed   60     1/12     0.003   +11 (+18.3pp)    [+6.8, +28.7]pp     —           
  Claude judge · topic — content · partition             all     240    0/53     <0.001  +53 (+22.1pp)    [+16.6, +27.2]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · topic — content · partition · A/A twin  all     240    0/51     <0.001  +51 (+21.3pp)    [+15.9, +26.3]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · content only · partition                all     240    0/51     <0.001  +51 (+21.3pp)    [+15.9, +26.3]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · topic — content · fuse                  all     240    18/2     <0.001  -16 (-6.7pp)     [-10.2, -3.0]pp     no          YES (arm worse)
                                                         same    60     15/1     <0.001  -14 (-23.3pp)    [-34.3, -10.8]pp    —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —           
  found@8:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                      all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic only                              all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · partition             all     240    5/13     0.096   +8 (+3.3pp)      [-0.2, +6.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/8      0.227   +5 (+8.3pp)      [-2.7, +18.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · content only · partition                all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · fuse                  all     240    6/9      0.607   +3 (+1.3pp)      [-2.0, +4.5]pp      no          no
                                                         same    60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —           
                                                         cross   60     3/4      1.000   +1 (+1.7pp)      [-7.3, +10.5]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
```

### A/A sanity check

```
A/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so its p on `all`
must stay ≥ 0.05; if it does not, the paired test is seeing something that is not there and the run is suspect.

formula vs formula2 (engine — no model in the loop):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   +0 / +0 / +0.000           ·   p 1.000, 1.000
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     +0 / +0 / +0.000           ·   p 1.000, 1.000

content vs content2 (judge — the LLM's verdicts vary run to run):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   -2 / -2 / -0.033           ·   p 0.500, 0.500
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     -2 / -2 / -0.008           ·   p 0.500, 0.500
```

Both A/A pairs stay at p ≥ 0.05 on `all`, so the run passes its own sanity check. `formula`/`formula2` are
byte-identical everywhere (no model in the loop — expected). `content`/`content2` differ by exactly 2 queries,
both in the `cross` set (p = 0.500) — the LLM judge's verdicts are not perfectly reproducible run to run, and
this is the size of that noise on 240 paired queries (see "What it does NOT say").

### Latency and candidate-text size

```
latency (ms) — parallel: mean over the accuracy pass, 7 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                    ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)             337            211                 0/0                       0/0                    off · claude-cli · haiku
公式 · no verification · A/A twin                      339            226                 0/0                       0/0                    off · claude-cli · haiku
Claude judge · topic only                              14387          11722               233/1                     245/1                  on · claude-cli · haiku
Claude judge · topic — content · partition             14702          9531                231/3                     243/3                  on · claude-cli · haiku
Claude judge · topic — content · partition · A/A twin  14644          8969                234/0                     246/0                  on · claude-cli · haiku
Claude judge · content only · partition                14712          8733                233/1                     245/1                  on · claude-cli · haiku
Claude judge · topic — content · fuse                  14709          9033                233/1                     245/1                  on · claude-cli · haiku

candidate text per recall (estimated; 60 candidates at most — the engine gathers only what matches or links; numbering, instructions and the query are excluded, and chars ≠ tokens):
  Claude judge · topic only                              up to ~609 chars (10 per candidate)
  Claude judge · topic — content · partition             up to ~3306 chars (55 per candidate)
  Claude judge · topic — content · partition · A/A twin  up to ~3306 chars (55 per candidate)
  Claude judge · content only · partition                up to ~2517 chars (42 per candidate)
  Claude judge · topic — content · fuse                  up to ~3306 chars (55 per candidate)
```

### Warnings

```
WARNING: arm topic — 1 claude-cli call(s) failed during the accuracy pass
WARNING: arm content — 3 claude-cli call(s) failed during the accuracy pass
WARNING: arm contentonly — 1 claude-cli call(s) failed during the accuracy pass
WARNING: arm fuse — 1 claude-cli call(s) failed during the accuracy pass
```

No `judge failed open` warning fired for any arm (see the CLI-failures bullet below for why).

### What it says

- **Judge vs 公式, by set.** `content` (topic — content · partition) is the strongest arm against the no-verification
  baseline: on `all`, top-1 moves from 79/240 to 132/240 — paired vs formula 0/53, p < 0.001, net +53 = **+22.1pp**,
  95% CI **[+16.6, +27.2]pp** (finding: arm better) — and every per-set top-1 comparison agrees in direction and is
  itself significant (same +25.0pp p<.001, cross +16.7pp p=.002, third +25.0pp p<.001, mixed +21.7pp p<.001), so
  nothing in the per-set tables contradicts the `all` finding. found@8 moves from 125/240 to 133/240 but is **not**
  a finding (net +8 = +3.3pp, 95% CI [-0.2, +6.8]pp, p = 0.096 — just short of 0.05). `topic`-only also beats
  formula on top-1 (net +41 = +17.1pp, 95% CI [+11.6, +22.3]pp, p < 0.001, same direction in all four sets) but by
  less than `content`, and likewise does not reach a found@8 finding (net +6 = +2.5pp, 95% CI [-0.8, +5.8]pp,
  p = 0.210). `fuse` is the one judge configuration that **loses** to formula on top-1: net -16 = **-6.7pp**,
  95% CI [-10.2, -3.0]pp, p < 0.001 (finding: arm worse) — driven almost entirely by the same-language set
  (-23.3pp, p < 0.001), where fuse scores only 28/60 against formula's own 42/60. Fusing the two verdicts makes the
  judge worse than running no judge at all on the easiest set.
- **topic-only vs content — is the fix confirmed?** Yes, on top-1: `content` beats `topic`-only (paired vs content:
  12/0, p < 0.001, net -12 = **-5.0pp** in content's favor, 95% CI [-7.8, -2.1]pp, not equivalent — finding: topic-only
  worse). No per-set comparison runs opposite (same 4/0 p=.125, cross 2/0 p=.500, third 4/0 p=.125, mixed 2/0
  p=.500 — none individually significant, none in the opposite direction), so the `all` finding stands under the
  paired-test rule. On found@8 the two are **equivalent** (2/0, net -0.8pp, 95% CI [-2.2, +0.6]pp, inside ±3pp):
  whichever text the judge sees, the right fact still lands somewhere in the top 8 — showing content changes only
  which one gets ranked first.
- **topic — content (partition) vs content only — equivalence verdict, and the ContentChars decision.**
  Equivalent on both metrics: top-1 net -0.8pp (2/0, p = 0.500, 95% CI [-2.2, +0.6]pp, inside ±3pp) and found@8
  the same (2/0, p = 0.500, 95% CI [-2.2, +0.6]pp). Per set the two arms are identical on same/third/mixed (0/0
  pairs, p = 1.000) and differ only on `cross` (2/0, p = 0.500, not significant). Latency and candidate size both
  favor dropping the topic prefix: content-only's serial median is 8733 ms against partition's 9531 ms, and its
  estimated candidate text tops out at ~2517 chars (42/candidate) against partition's ~3306 chars (55/candidate) —
  about 24% smaller, for a result the paired test cannot tell apart from partition's. Applying the plan's decision
  rule literally: the equivalence holds on `all`, so **the topic prefix does not earn its tokens** — when Lyntai
  ships `LlmVerificationOptions.ContentChars` (content alone; task-archive Part 276 / D170), the `JudgeSeesContentPolicy`
  topic-prefix decorator should be deleted in favor of it.
- **topic — content (partition) vs fuse — does fuse change the default?** No. Against `content`, `fuse` is
  significantly **worse** on top-1 (69/0, p < 0.001, net -69 = -28.8pp, 95% CI [-34.3, -22.8]pp, not equivalent),
  and the direction holds in every set (same -48.3pp p<.001, cross -16.7pp p=.002, third -25.0pp p<.001, mixed
  -25.0pp p<.001) — the opposite of what the plan's adoption rule requires (fuse would need to beat content with
  p < 0.05 on `all` and no set significantly worse). found@8 is inconclusive rather than a point in fuse's favor:
  5/0 pairs give p = 0.063 (not < 0.05) next to a 95% CI of [-4.0, -0.1]pp — outside ±3pp on the low end, so
  neither a finding nor equivalence. This is the exact small-count case the plan's own worked example describes
  (a handful of one-sided pairs reading as "neither"). Combined with fuse also losing to formula on top-1 (first
  bullet), fuse stays what Lyntai calls it — insurance, not the default.
- **Latency.** Serial medians (one arm at a time, 12 queries) run **8733-11722 ms** for every judge arm against
  **211-226 ms** for 公式 with no verification — roughly 40-55× slower per recall, regardless of whether the judge
  saw the topic only, the content only, or both (a CLI spawn per call dominates, not the size of what it reads).
  The parallel means (14249-15880 ms) are **not** a per-call estimate — they were measured with all 7 arms
  recalling at once, so they are contended; the serial pass is the closer estimate of a single household's
  per-recall cost.
- **CLI failures.** 6 claude-cli calls failed during the accuracy pass across the 5 judge arms combined (topic 1,
  content 3, contentonly 1, fuse 1, content2 0) against 234 graph recalls per arm (1170 judge calls total) — about
  0.5%. Every judge arm still produced a verdict for at least 98% of its graph recalls (topic 233/234 = 99.6%,
  content 231/234 = 98.7%, content2 234/234 = 100%, contentonly 233/234 = 99.6%, fuse 233/234 = 99.6%), so none
  crossed the bench's own 2%-unjudged threshold and **no arm failed open** on this run — the WARNING lines above
  name only the raw call failures, and no "judge failed open" line ever fired. The router counts every attempt, so
  a retried attempt that eventually succeeded would still show up as one of those failure lines; that caveat
  doesn't hide anything here, because judged equals graph minus failed exactly for all five arms (e.g. content:
  234 − 3 = 231), meaning each failed attempt cost its recall a verdict rather than being papered over by a
  successful retry.

### What it does NOT say

- One fixture (60 invented facts), one run per arm, a single judge model (`haiku`) and a single CLI version
  (`2.1.280 (Claude Code)`). Nothing here says how another model, another CLI version, or a household's own
  facts would score.
- 语义 was off in every arm — this measures the judge alone. Cross-language recall had no semantic channel to
  bridge languages, which is part of why even the best judge arm's cross/third-language top-1 stayed low (11/60
  and 16/60) next to same-language's 57/60; these numbers say what the judge alone buys, not judge + semantic.
- Kind-filtered recalls, which can carry up to 400 candidates, were not exercised — the fixture's 60 facts keep
  every recall inside the un-filtered graph regime, so nothing here says how the judge or the content-size
  tradeoff behaves at that scale.
- Candidate-text sizes are estimates that exclude prompt overhead (instructions, numbering, the query itself) and
  count characters, not tokens — they price the candidates only, not the full judge call.
- The fixture's questions are hand-reviewed, not raw generator output: 76 of 240 were edited in one commit, and
  the four Japanese facts' third-language questions were hand-written in another (per `judge-bench-fixture.mjs`'s
  own header). The questions this run answered were curated, not sampled unreviewed from a model.
- The `content` vs `content2` A/A pair — identical configuration, identical starting graph — still differed by
  2 queries (both in `cross`, p = 0.500, within the sanity threshold). That is the smallest real difference this
  run's own noise floor produced by chance alone; a reported gap of that size or smaller in any other comparison
  should be read as within the run's own measurement noise, not as a finding.

## Run 2 — rerankers (2026-09-23, llama.cpp b10549; claude 2.1.280, never called)

**Command**

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,formula2 \
  --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res \
  --baseline=devtools/_judge-bench/results-2026-09-23T091740.681Z.json:content \
  --port-base=5620 --llama-port=5660 > devtools/_judge-bench-rr.txt 2>&1
```

`--resources` pointed at a scratch folder holding the pinned llama.cpp runtime (`b10549`, Vulkan x64) and both
GGUFs, each sha256-checked against its `GgufCatalog` pin — not at a household's data folder, which this run never
read. The two port flags restate the defaults, which sat outside every tcp range Windows had reserved on the
machine that day.

**Seed** — Run 1's, reused (created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`,
fixture sha256 `9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555`).
App HEAD `bc7041c` (v1.2.0). Order seed **12345** (240 queries, 0 same-fact adjacencies), **6 arms in
parallel**, latency sample 12 queries. Formula positions digest **`f661eb6a056e`** —
**equal to Run 1's**, so both runs asked the same questions, in the same order, of the same starting graph. That
is what lets `--baseline` pair every arm here with Run 1's `content` arm query by query, and it accepted the
pairing (digest, order seed, fact count and fixture hash all match). No arm made a claude-cli call at startup or
during the run (0/0 in every row of the latency table below): nothing was re-derived from the seed, and the
subject tags every arm recalls against are the seed's, written by the CLI.

**Read this before the numbers — how a reranker's verdict reaches the page.** The app binds a reranker through
Lyntai's `ScoringVerificationPolicy` with `EndorseCount` = `RecallFactsTool.DefaultRecallLimit` = 8, which is also
this bench's page size. Every recall, the reranker scores every candidate and endorses its 8 best. Under
**partition** (the product's default) the endorsed group is promoted ahead of everything else **keeping the
engine's own order inside it** — the verdict is one bit per candidate, and the reranker's scores are not used for
ordering. So under partition the reranker decides WHICH eight facts reach the page and the engine decides which
of them comes FIRST. Two consequences run through every table below: `endorsed` equals `judged` in every reranker
arm by construction (it endorses a full page each time — not a sign of anything, unlike Run 1's Claude `content`
arm, which reached the graph on 234 recalls, returned a verdict on 231 of them, and on 129 of those judged the
question answered — `endorsed` counts recalls, not candidates),
and the reranker's effect lands on found@8 far more than on top-1.

### Accuracy — the four sets and `all`

```
== same ==
arm                                             n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)      60   0    60     0       0         42/60     54/60     0.769   320            
公式 · no verification · A/A twin               60   0    60     0       0         42/60     54/60     0.769   315            +0 / +0 / +0.000
reranker LAMAR-600m.Q5_K_M · partition          60   0    60     60      60        42/60     57/60     0.795   608            +0 / +3 / +0.027
reranker LAMAR-600m.Q5_K_M · fuse               60   0    60     60      60        42/60     55/60     0.785   607            +0 / +1 / +0.017
reranker bge-reranker-v2-m3-Q5_K_M · partition  60   0    60     60      60        43/60     57/60     0.808   621            +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse       60   0    60     60      60        42/60     55/60     0.790   643            +0 / +1 / +0.021

== cross ==
arm                                             n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)      60   0    60     0       0         1/60      6/60      0.042   384            
公式 · no verification · A/A twin               60   0    60     0       0         1/60      6/60      0.042   383            +0 / +0 / +0.000
reranker LAMAR-600m.Q5_K_M · partition          60   0    60     60      60        1/60      49/60     0.174   836            +0 / +43 / +0.133
reranker LAMAR-600m.Q5_K_M · fuse               60   0    60     60      60        1/60      9/60      0.051   834            +0 / +3 / +0.009
reranker bge-reranker-v2-m3-Q5_K_M · partition  60   0    60     60      60        3/60      48/60     0.221   843            +2 / +42 / +0.179
reranker bge-reranker-v2-m3-Q5_K_M · fuse       60   0    60     60      60        2/60      12/60     0.071   832            +1 / +6 / +0.030

== third ==
arm                                             n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)      60   0    55     0       0         1/60      18/60     0.119   328            
公式 · no verification · A/A twin               60   0    55     0       0         1/60      18/60     0.119   331            +0 / +0 / +0.000
reranker LAMAR-600m.Q5_K_M · partition          60   0    55     55      55        5/60      45/60     0.274   708            +4 / +27 / +0.155
reranker LAMAR-600m.Q5_K_M · fuse               60   0    55     55      55        5/60      22/60     0.191   710            +4 / +4 / +0.072
reranker bge-reranker-v2-m3-Q5_K_M · partition  60   0    55     55      55        7/60      42/60     0.278   695            +6 / +24 / +0.159
reranker bge-reranker-v2-m3-Q5_K_M · fuse       60   0    55     55      55        8/60      21/60     0.209   700            +7 / +3 / +0.089

== mixed ==
arm                                             n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)      60   0    59     0       0         35/60     47/60     0.657   375            
公式 · no verification · A/A twin               60   0    59     0       0         35/60     47/60     0.657   375            +0 / +0 / +0.000
reranker LAMAR-600m.Q5_K_M · partition          60   0    59     59      59        38/60     57/60     0.731   818            +3 / +10 / +0.074
reranker LAMAR-600m.Q5_K_M · fuse               60   0    59     59      59        37/60     51/60     0.702   826            +2 / +4 / +0.045
reranker bge-reranker-v2-m3-Q5_K_M · partition  60   0    59     59      59        37/60     56/60     0.720   808            +2 / +9 / +0.063
reranker bge-reranker-v2-m3-Q5_K_M · fuse       60   0    59     59      59        35/60     51/60     0.681   808            +0 / +4 / +0.024

== all ==
arm                                             n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)      240  0    234    0       0         79/240    125/240   0.397   352            
公式 · no verification · A/A twin               240  0    234    0       0         79/240    125/240   0.397   351            +0 / +0 / +0.000
reranker LAMAR-600m.Q5_K_M · partition          240  0    234    234     234       86/240    208/240   0.494   743            +7 / +83 / +0.097
reranker LAMAR-600m.Q5_K_M · fuse               240  0    234    234     234       85/240    137/240   0.432   744            +6 / +12 / +0.035
reranker bge-reranker-v2-m3-Q5_K_M · partition  240  0    234    234     234       90/240    203/240   0.507   742            +11 / +78 / +0.110
reranker bge-reranker-v2-m3-Q5_K_M · fuse       240  0    234    234     234       87/240    139/240   0.438   746            +8 / +14 / +0.041
```

### Paired vs `formula` — McNemar exact, per query

`b` = formula hit & arm miss, `c` = formula miss & arm hit. Interval = Agresti–Min 95% for the net rate
`(c − b) / pairs`; equivalence needs the whole interval inside ±3pp.

```
  top-1:
  arm                                             set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin               all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                  same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  reranker LAMAR-600m.Q5_K_M · partition          all     240    1/8      0.039   +7 (+2.9pp)      [+0.4, +5.4]pp      no          YES (arm better)
                                                  same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                  cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  third   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —           
                                                  mixed   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
  reranker LAMAR-600m.Q5_K_M · fuse               all     240    1/7      0.070   +6 (+2.5pp)      [+0.1, +4.9]pp      no          no
                                                  same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                  cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  third   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —           
                                                  mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  reranker bge-reranker-v2-m3-Q5_K_M · partition  all     240    3/14     0.013   +11 (+4.6pp)     [+1.2, +7.9]pp      no          YES (arm better)
                                                  same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —           
                                                  cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                  third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —           
                                                  mixed   60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · fuse       all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                  same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —           
                                                  cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —           
                                                  third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —           
                                                  mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
  found@8:
  arm                                             set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin               all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                  same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  reranker LAMAR-600m.Q5_K_M · partition          all     240    0/83     <0.001  +83 (+34.6pp)    [+28.3, +40.3]pp    no          YES (arm better)
                                                  same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                  cross   60     0/43     <0.001  +43 (+71.7pp)    [+57.5, +81.3]pp    —           
                                                  third   60     0/27     <0.001  +27 (+45.0pp)    [+30.8, +56.3]pp    —           
                                                  mixed   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —           
  reranker LAMAR-600m.Q5_K_M · fuse               all     240    3/15     0.008   +12 (+5.0pp)     [+1.5, +8.4]pp      no          YES (arm better)
                                                  same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —           
                                                  cross   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —           
                                                  third   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —           
                                                  mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · partition  all     240    1/79     <0.001  +78 (+32.5pp)    [+26.2, +38.3]pp    no          YES (arm better)
                                                  same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                  cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —           
                                                  third   60     1/25     <0.001  +24 (+40.0pp)    [+25.4, +52.0]pp    —           
                                                  mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · fuse       all     240    5/19     0.007   +14 (+5.8pp)     [+1.8, +9.8]pp      no          YES (arm better)
                                                  same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —           
                                                  cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —           
                                                  third   60     2/5      0.453   +3 (+5.0pp)      [-4.0, +13.7]pp     —           
                                                  mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —           
```

### Paired across runs vs Run 1's `content` — McNemar exact, per query

Same seed, same order, digest `f661eb6a056e` on both sides. `b` = Run 1 `content` hit & arm miss, `c` = the
reverse.

```
  top-1:
  arm                                             set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)      all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                  same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                  third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  公式 · no verification · A/A twin               all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                  same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                  third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  reranker LAMAR-600m.Q5_K_M · partition          all     240    47/1     <0.001  -46 (-19.2pp)    [-24.1, -13.9]pp    no          YES (arm worse)
                                                  same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                  third   60     11/0     <0.001  -11 (-18.3pp)    [-27.8, -7.7]pp     —           
                                                  mixed   60     11/1     0.006   -10 (-16.7pp)    [-26.8, -5.5]pp     —           
  reranker LAMAR-600m.Q5_K_M · fuse               all     240    48/1     <0.001  -47 (-19.6pp)    [-24.6, -14.2]pp    no          YES (arm worse)
                                                  same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                  third   60     11/0     <0.001  -11 (-18.3pp)    [-27.8, -7.7]pp     —           
                                                  mixed   60     12/1     0.003   -11 (-18.3pp)    [-28.7, -6.8]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · partition  all     240    44/2     <0.001  -42 (-17.5pp)    [-22.5, -12.3]pp    no          YES (arm worse)
                                                  same    60     14/0     <0.001  -14 (-23.3pp)    [-33.5, -11.7]pp    —           
                                                  cross   60     9/1      0.021   -8 (-13.3pp)     [-22.9, -2.9]pp     —           
                                                  third   60     9/0      0.004   -9 (-15.0pp)     [-23.8, -5.2]pp     —           
                                                  mixed   60     12/1     0.003   -11 (-18.3pp)    [-28.7, -6.8]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · fuse       all     240    45/0     <0.001  -45 (-18.8pp)    [-23.6, -13.6]pp    no          YES (arm worse)
                                                  same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                  cross   60     9/0      0.004   -9 (-15.0pp)     [-23.8, -5.2]pp     —           
                                                  third   60     8/0      0.008   -8 (-13.3pp)     [-21.8, -4.0]pp     —           
                                                  mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  found@8:
  arm                                             set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)      all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                  same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                  cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                  third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                  mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  公式 · no verification · A/A twin               all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                  same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                  cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                  third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                  mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  reranker LAMAR-600m.Q5_K_M · partition          all     240    1/76     <0.001  +75 (+31.3pp)    [+25.0, +37.0]pp    no          YES (arm better)
                                                  same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  cross   60     0/38     <0.001  +38 (+63.3pp)    [+48.8, +73.8]pp    —           
                                                  third   60     0/29     <0.001  +29 (+48.3pp)    [+34.0, +59.6]pp    —           
                                                  mixed   60     1/9      0.021   +8 (+13.3pp)     [+2.9, +22.9]pp     —           
  reranker LAMAR-600m.Q5_K_M · fuse               all     240    12/16    0.572   +4 (+1.7pp)      [-2.7, +6.0]pp      no          no
                                                  same    60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                  cross   60     8/6      0.791   -2 (-3.3pp)      [-15.4, +9.0]pp     —           
                                                  third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —           
                                                  mixed   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · partition  all     240    1/71     <0.001  +70 (+29.2pp)    [+23.0, +34.8]pp    no          YES (arm better)
                                                  same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                  cross   60     0/37     <0.001  +37 (+61.7pp)    [+47.1, +72.3]pp    —           
                                                  third   60     0/26     <0.001  +26 (+43.3pp)    [+29.3, +54.6]pp    —           
                                                  mixed   60     1/8      0.039   +7 (+11.7pp)     [+1.7, +20.9]pp     —           
  reranker bge-reranker-v2-m3-Q5_K_M · fuse       all     240    12/18    0.362   +6 (+2.5pp)      [-2.0, +7.0]pp      no          no
                                                  same    60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                  cross   60     8/9      1.000   +1 (+1.7pp)      [-11.8, +15.0]pp    —           
                                                  third   60     0/5      0.063   +5 (+8.3pp)      [+0.6, +15.5]pp     —           
                                                  mixed   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —           
```

### Paired — every reranker against every other

`b` = right-hand arm hit & left-hand arm miss, `c` = the reverse (`rr:` = partition, `rrf:` = fuse).

```
  top-1:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  rrf:LAMAR-600m.Q5_K_M vs rr:LAMAR-600m.Q5_K_M                  all     240    1/0      1.000   -1 (-0.4pp)      [-1.6, +0.7]pp      YES         no
                                                                 same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                                 third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                                 mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
  rr:bge-reranker-v2-m3-Q5_K_M vs rr:LAMAR-600m.Q5_K_M           all     240    2/6      0.289   +4 (+1.7pp)      [-0.8, +4.1]pp      no          no
                                                                 same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —           
                                                                 cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                                 third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                                 mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rr:LAMAR-600m.Q5_K_M          all     240    4/5      1.000   +1 (+0.4pp)      [-2.1, +3.0]pp      YES         no
                                                                 same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                                 cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —           
                                                                 third   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                                 mixed   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
  rr:bge-reranker-v2-m3-Q5_K_M vs rrf:LAMAR-600m.Q5_K_M          all     240    2/7      0.180   +5 (+2.1pp)      [-0.5, +4.6]pp      no          no
                                                                 same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —           
                                                                 cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                                 third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                                 mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rrf:LAMAR-600m.Q5_K_M         all     240    3/5      0.727   +2 (+0.8pp)      [-1.6, +3.3]pp      no          no
                                                                 same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                                 cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —           
                                                                 third   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                                 mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    4/1      0.375   -3 (-1.3pp)      [-3.2, +0.7]pp      no          no
                                                                 same    60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
                                                                 cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
                                                                 third   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —           
                                                                 mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  found@8:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  rrf:LAMAR-600m.Q5_K_M vs rr:LAMAR-600m.Q5_K_M                  all     240    71/0     <0.001  -71 (-29.6pp)    [-35.1, -23.5]pp    no          YES (arm worse)
                                                                 same    60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                                 cross   60     40/0     <0.001  -40 (-66.7pp)    [-76.8, -52.2]pp    —           
                                                                 third   60     23/0     <0.001  -23 (-38.3pp)    [-49.5, -24.7]pp    —           
                                                                 mixed   60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —           
  rr:bge-reranker-v2-m3-Q5_K_M vs rr:LAMAR-600m.Q5_K_M           all     240    5/0      0.063   -5 (-2.1pp)      [-4.0, -0.1]pp      no          no
                                                                 same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                                 cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
                                                                 third   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                                 mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rr:LAMAR-600m.Q5_K_M          all     240    69/0     <0.001  -69 (-28.8pp)    [-34.3, -22.8]pp    no          YES (arm worse)
                                                                 same    60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                                 cross   60     37/0     <0.001  -37 (-61.7pp)    [-72.3, -47.1]pp    —           
                                                                 third   60     24/0     <0.001  -24 (-40.0pp)    [-51.2, -26.2]pp    —           
                                                                 mixed   60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —           
  rr:bge-reranker-v2-m3-Q5_K_M vs rrf:LAMAR-600m.Q5_K_M          all     240    1/67     <0.001  +66 (+27.5pp)    [+21.5, +33.1]pp    no          YES (arm better)
                                                                 same    60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                                 cross   60     0/39     <0.001  +39 (+65.0pp)    [+50.5, +75.3]pp    —           
                                                                 third   60     0/20     <0.001  +20 (+33.3pp)    [+20.2, +44.3]pp    —           
                                                                 mixed   60     1/6      0.125   +5 (+8.3pp)      [-0.6, +16.8]pp     —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rrf:LAMAR-600m.Q5_K_M         all     240    5/7      0.774   +2 (+0.8pp)      [-2.1, +3.7]pp      no          no
                                                                 same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                                 cross   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                                 third   60     3/2      1.000   -1 (-1.7pp)      [-9.3, +6.1]pp      —           
                                                                 mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
  rrf:bge-reranker-v2-m3-Q5_K_M vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    64/0     <0.001  -64 (-26.7pp)    [-32.1, -20.8]pp    no          YES (arm worse)
                                                                 same    60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                                 cross   60     36/0     <0.001  -36 (-60.0pp)    [-70.7, -45.4]pp    —           
                                                                 third   60     21/0     <0.001  -21 (-35.0pp)    [-46.1, -21.7]pp    —           
                                                                 mixed   60     5/0      0.063   -5 (-8.3pp)      [-15.5, -0.6]pp     —           
```

### A/A sanity check

```
A/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so its p on `all`
must stay ≥ 0.05; if it does not, the paired test is seeing something that is not there and the run is suspect.

formula vs formula2 (engine — no model in the loop):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   +0 / +0 / +0.000           ·   p 1.000, 1.000
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     +0 / +0 / +0.000           ·   p 1.000, 1.000

judge A/A: NOT run (add content,content2) — nothing shows how far the judge wanders between identical runs.

formula positions digest: f661eb6a056e (240 queries, 60 facts, order seed 12345) — equal digests across runs mean identical formula rows, the precondition for comparing runs
```

The engine A/A pair is byte-identical everywhere, so the run passes its own sanity check. There is **no model A/A
pair in this run**: the bench's model twin is `content2`, the Claude judge, and no reranker arm ran twice (see
"What it does NOT say").

### Latency

```
latency (ms) — parallel: mean over the accuracy pass, 6 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                             ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)      352            226                 0/0                       0/0                    off · claude-cli · haiku
公式 · no verification · A/A twin               351            245                 0/0                       0/0                    off · claude-cli · haiku
reranker LAMAR-600m.Q5_K_M · partition          743            474                 0/0                       0/0                    on · llama-cpp · LAMAR-600m.Q5_K_M
reranker LAMAR-600m.Q5_K_M · fuse               744            423                 0/0                       0/0                    on · llama-cpp · LAMAR-600m.Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · partition  742            489                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · fuse       746            432                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
```

### Warnings

None. The bench printed no WARNING line: no reranker arm left a graph recall without a verdict (`judged` equals
`graph` in every set), no query errored, and no claude-cli call was made at startup or at any time during the
run.

### By fact language — the household's case

Not the bench's own output: computed from this run's saved rows and Run 1's (`results-2026-09-23T113455.224Z.json`,
`results-2026-09-23T091740.681Z.json`), by the fact's language as `recall-questions.mjs` decides it (40 Chinese,
16 English, 4 Japanese facts). top-1 / found@8 / n, for all twelve set × fact-language rows; their totals
reproduce the `all` row of each arm above. The Chinese-fact rows of `same` and `mixed` are the household's case:
Chinese facts, asked in Chinese or code-switched. The Japanese rows are four facts each, too few to read on their
own.

```
set · facts   公式          LAMAR · partition  BGE · partition  LAMAR · fuse  BGE · fuse  Claude content (Run 1)
same · zh     31 / 36 / 40  30 / 37 / 40       29 / 37 / 40     30 / 35 / 40  29 / 35 / 40  37 / 37 / 40
same · en      7 / 14 / 16   8 / 16 / 16       10 / 16 / 16      8 / 16 / 16   9 / 16 / 16  16 / 16 / 16
same · ja      4 /  4 /  4   4 /  4 /  4        4 /  4 /  4      4 /  4 /  4   4 /  4 /  4   4 /  4 /  4
cross · zh     0 /  0 / 40   0 / 30 / 40        0 / 30 / 40      0 /  1 / 40   0 /  3 / 40   7 /  7 / 40
cross · en     1 /  5 / 16   1 / 15 / 16        2 / 14 / 16      1 /  7 / 16   2 /  7 / 16   4 /  4 / 16
cross · ja     0 /  1 /  4   0 /  4 /  4        1 /  4 /  4      0 /  1 /  4   0 /  2 /  4   0 /  0 /  4
third · zh     1 / 13 / 40   5 / 30 / 40        5 / 28 / 40      5 / 15 / 40   5 / 15 / 40  12 / 12 / 40
third · en     0 /  4 / 16   0 / 12 / 16        1 / 11 / 16      0 /  5 / 16   2 /  4 / 16   3 /  3 / 16
third · ja     0 /  1 /  4   0 /  3 /  4        1 /  3 /  4      0 /  2 /  4   1 /  2 /  4   1 /  1 /  4
mixed · zh    21 / 31 / 40  23 / 39 / 40       23 / 38 / 40     22 / 33 / 40  22 / 33 / 40  32 / 33 / 40
mixed · en    14 / 16 / 16  14 / 16 / 16       13 / 16 / 16     14 / 16 / 16  13 / 16 / 16  16 / 16 / 16
mixed · ja     0 /  0 /  4   1 /  2 /  4        1 /  2 /  4      1 /  2 /  4   0 /  2 /  4   0 /  0 /  4
```

LAMAR against BGE (partition), paired on the same queries (LAMAR-only hits / BGE-only hits), counted three ways
because "Chinese questions" can mean two different selections:

- **The household's case** — Chinese facts asked in Chinese or code-switched (`same` × zh + `mixed` × zh, 80
  queries): top-1 1/0, found@8 1/0. Two disagreements, both LAMAR's.
- **Every Chinese-worded question** — `same` × zh, `cross` × en and `third` × ja (asked in Chinese), and every
  `mixed` question (120 queries): top-1 2/2, found@8 2/0. Six disagreements: four LAMAR's, two BGE's — on six
  DISTINCT questions, none differing on both metrics (recounted 2026-09-24: top-1 on `mixed`|anniversary and
  `same`|pharm-24h for LAMAR, `third`|onsen and `cross`|flu-shot for BGE; found@8 on `cross`|train-express and
  `mixed`|movie, both LAMAR's).
- **All 240**: top-1 2/6 (BGE's way — e.g. `same` × English facts, 0/2), found@8 5/0 (LAMAR's way).

None of these reaches the exact test on its own; see "LAMAR vs BGE" below for which way the evidence leans.

### What it says

- **Reranker vs 公式, by set.** Under partition both rerankers are a large, significant gain on **found@8**: LAMAR
  125 → 208/240 (paired 0/83, p < 0.001, net +83 = **+34.6pp**, 95% CI **[+28.3, +40.3]pp**), BGE 125 → 203/240
  (1/79, p < 0.001, net +78 = **+32.5pp**, [+26.2, +38.3]pp). The gain is where the lexical floor fails: cross
  6 → 49 / 48 of 60 (+71.7 / +70.0pp, both p < 0.001), third 18 → 45 / 42 (+45.0 / +40.0pp, p < 0.001), mixed
  47 → 57 / 56 (+16.7pp p = 0.002 / +15.0pp p = 0.004); on `same`, where formula already found 54/60, +3 each
  (p = 0.250, not significant). On **top-1** the gain is small but it is a finding for both: LAMAR +7 = **+2.9pp**
  (1/8, p = 0.039, [+0.4, +5.4]pp), BGE +11 = **+4.6pp** (3/14, p = 0.013, [+1.2, +7.9]pp); no set is
  significant in the opposite direction, and the only significant set is BGE's `third` (+10.0pp, p = 0.031). That
  top-1 barely moves is the partition's arithmetic described above, not the reranker failing to rank: in `cross`,
  LAMAR puts the answer on the page 49 times out of 60 and first once, because first is still the engine's pick,
  and the engine's cross-language ranking is near random (formula 1/60).
- **Reranker vs the Claude judge (Run 1's `content`, same seed).** The two judges make opposite trades. On
  **top-1** every reranker arm is significantly **worse** than the Claude judge: LAMAR partition 86 vs 132
  (47/1, p < 0.001, net −46 = **−19.2pp**, [−24.1, −13.9]pp), BGE partition 90 vs 132 (44/2, net −42 =
  **−17.5pp**, [−22.5, −12.3]pp), and every set agrees, each one itself significant (same −25.0 / −23.3pp, cross
  −16.7 / −13.3pp, third −18.3 / −15.0pp, mixed −16.7 / −18.3pp). On **found@8** both partition arms are
  significantly **better**: LAMAR 208 vs 133 (1/76, p < 0.001, net +75 = **+31.3pp**, [+25.0, +37.0]pp), BGE 203
  vs 133 (1/71, net +70 = **+29.2pp**, [+23.0, +34.8]pp) — from cross (+63.3 / +61.7pp), third (+48.3 / +43.3pp)
  and mixed (+13.3pp p = 0.021 / +11.7pp p = 0.039), while on `same` their found@8 hits are identical query
  for query (0/0).
  Both judges are shown the same candidate list (up to 60). The Claude judge endorses only what it judges to
  answer: when it finds the answer, partition puts it first, so its top-1 and found@8 hits nearly coincide (132
  and 133); when it does not, the page stays the engine's, which is why its found@8 is barely above 公式's (133
  vs 125, not a finding in Run 1). A reranker always endorses a full page of its eight best, so the answer lands
  on the page far more often, in whatever position the engine gives it. The fuse arms reach neither finding
  against `content` on found@8 (LAMAR +4, p = 0.572; BGE +6, p = 0.362) and lose on top-1 like the partition
  arms.
- **Serial latency.** One arm at a time over 12 queries, the reranker arms' median recall is **423–489 ms**
  against **226–245 ms** for 公式 alone: a reranker verdict adds roughly 0.18–0.26 s per recall against either
  公式 arm — 0.23–0.26 s under partition (474 / 489 ms), 0.18–0.21 s under fuse (423 / 432 ms). Run 1's Claude
  judge arms took **8733–11722 ms** on the same measure (content · partition 9531 ms), so a reranker recall is
  about 20× faster than a Claude-judged one and spends no account quota. The parallel means (742–746 ms against
  351–352) were contended: six arms at once, all four reranker arms sharing one llama-server router on one GPU.
- **LAMAR vs BGE — no finding either way, and the two leans are NOT symmetric.** Paired in this run, partition
  against partition. On **found@8** — the metric where a reranker's value lies — LAMAR leads **5–0** (BGE's net
  −5 = −2.1pp, p = 0.063, 95% CI **[−4.0, −0.1]pp**): the exact test just misses 0.05 while the bench's own
  Agresti–Min interval EXCLUDES zero. The bench's rule is the exact test, so this is not a finding — but it is a
  lean with nothing on the other side of it. On **top-1** BGE leads 6–2 (net +1.7pp, p = 0.289, [−0.8, +4.1]pp),
  an interval that comfortably includes zero. Neither measure is equivalent either (each interval reaches past
  ±3pp). So the stronger of the two leans is LAMAR's, on the metric that matters more for a reranker; reading
  them as "two point estimates pointing opposite ways" hides that. Fuse against fuse is significant neither way
  (top-1 3/5, p = 0.727, [−1.6, +3.3]pp; found@8 5/7, p = 0.774, [−2.1, +3.7]pp), and no single set is
  significant either way, under partition or fuse.
  By question (see "By fact language"): on the household's case the two disagree on 2 of 80 queries, both
  LAMAR's; across all 120 Chinese-worded questions on 6, four LAMAR's and two BGE's. BGE's six solo top-1 wins on
  `all` are ALL on questions about English or Japanese facts — two English facts asked in English (`same` × en,
  10 vs 8 of 16), one each in `cross` × en, `third` × en, `cross` × ja and `third` × ja — and none on a Chinese
  fact; LAMAR's two are `same` × zh and `mixed` × en. Latency is a wash (474 vs 489 ms serial, partition).
  **Recommended: `bge-reranker-v2-m3-Q5_K_M` — by the tie-break declared before the run and nothing else**
  (neither significant nor equivalent → the smaller file), which decided it by **1,408 bytes** (468,392,352
  against 468,393,760). The rule stands as registered: changing it after seeing which way the data leaned would be
  worse than a tie-break that runs against the lean. But it is a tie-break, not a measured preference — found@8
  leans the other way — and a household on LAMAR gives up nothing this fixture can show.
  `GgufCatalog.RecommendedReranker` and both reranker notes say so.
- **Partition vs fuse, per reranker.** For LAMAR, top-1 is **equivalent** (fuse vs partition 1/0, p = 1.000,
  95% CI [−1.6, +0.7]pp, inside ±3pp) and found@8 is significantly **worse** under fuse (71/0, p < 0.001,
  −29.6pp, [−35.1, −23.5]pp). For BGE, top-1 is **neither** (4/1, p = 0.375, [−3.2, +0.7]pp — the lower bound
  just past −3pp) and found@8 is significantly **worse** under fuse (64/0, p < 0.001, −26.7pp, [−32.1, −20.8]pp);
  in both, the found@8 loss comes mostly from cross and third, with no set significant the other way. Fuse gives
  back nearly all of the reranker's found@8 gain: against 公式 it keeps +12 / +14 on found@8 (+5.0pp p = 0.008 /
  +5.8pp p = 0.007, both findings) of partition's +83 / +78, and its top-1 gain over 公式 (+6 / +8) is not a
  finding (p = 0.070 / 0.057). That matches how Lyntai measured fuse, as insurance: here it sits at the base on
  top-1 and a little above it on found@8, with no set significantly below the base. Partition stays the default
  for a reranker binding.
  The partition's documented failure mode — a verdict endorsing a full page replaces the page instead of
  refining it — is exactly what happens here, because `EndorseCount` equals the page; on this fixture that
  replacement IS the benefit, and fuse, which exists to soften it, removes most of it.

### What it does NOT say

- One fixture (60 invented facts), one run per arm, one quantisation of each reranker (Q5_K_M), one llama.cpp
  build (`b10549`, Vulkan) on one machine's GPU. LAMAR against BGE is **unresolved**, not "equal": the bench showed
  neither a difference nor an equivalence — with found@8 leaning LAMAR (5–0, interval excluding zero, exact test
  just short) — and a larger or differently built fixture could separate them.
- Every arm recalled against the seed's subject tags, which the Claude CLI wrote when the seed was made. That
  matches a reranker household WITH a signed-in CLI, since a reranker binding still tags through it; a household
  without one — which the binding's cost line explicitly allows (「没有已登录的 CLI 时只是不标注」) — has no subject
  tags at all, and that configuration was not measured. Nothing here says what a reranker is worth without them.
- Run 1's `content` rows came from app `81e3ddd` and this run's from `bc7041c`, and the equal formula digest proves
  only that the FORMULA rows are identical: in between, `JudgeScopedModelRoutingStore` changed how the `memory`
  consumer's model is resolved, which is the path the `content` arm's CLI calls go through — for a CLI judge saved
  and running on the same client it passes the key through unchanged, so no difference is expected, but the arm
  was not re-run on `bc7041c` to show it.
- No reranker arm ran twice, so this run has no model A/A pair: nothing here shows how far a reranker arm drifts
  between identical runs. The Claude side of the cross-run comparison was also measured once — Run 1's own
  `content`/`content2` A/A differed by 2 queries — so a cross-run gap of that size is inside the noise. The
  cross-run findings above (42–75 queries) are more than an order of magnitude larger; the fuse arms' found@8
  gaps against `content` (+4, +6) are not, and were not findings.
- The top-1 numbers describe the COMBINATION (partition, one bit per candidate) as much as the rerankers. Both
  rerankers compute a score for every candidate and the engine does not order by it; nothing here measures what
  top-1 would be if it did. That is a design question this run raises and does not answer.
- The found@8 gain is tied to `EndorseCount` = 8 = this bench's page size = `recall_facts`' default. A caller
  asking for a different limit gets a different relationship between the endorsed set and the page (fewer than 8
  → the engine's first N of the reranker's 8; more than 8 → the reranker's 8, then the engine's). No other limit
  was measured.
- 语义 was off in every arm, as in Run 1. In these arms the reranker was the only component that reads across
  languages, which is much of why its cross/third found@8 gains are so large; with an embedder the candidate
  list itself changes, and none of these numbers say what a reranker adds on top of one.
- A reranker scores every candidate it is shown, so its cost grows with the list. The fixture keeps every recall
  at 60 candidates or fewer; kind-filtered recalls, which can carry up to 400, were not exercised, and nothing
  here prices them.
- Serial latency is a median over 12 queries with the reranker already warm; the cold load (~4.8 s, measured when
  the screen was written) is not in it. An unrelated llama-server process was resident on the same machine during
  the run.
- Recall-time only. A reranker binding still annotates every fact WRITE on the Claude CLI; this run made no
  writes, so that cost is not in these numbers.
- The questions are the same hand-reviewed ones as Run 1's (see its last-but-one bullet).

## Run 3 — the local chat judge (design)

Written and committed BEFORE the run; the results section that follows names this commit.

**The question.** On 2026-09-24 `JudgeSeesContentPolicy`'s default moved from `topic — content` to content alone,
on Run 1's measurement of the CLAUDE judge (equivalent on both metrics, ~24% less candidate text). `JudgeWiring.Llm`
builds the verifier for both LLM judges, so the same flip reached 判断 bound to a llama.cpp CHAT model — which
neither Run 1 nor Run 2 measured, in either mode. **Does content alone hurt a local chat judge relative to
`topic — content`?** Run 1's equivalence does not carry over by argument: a 1B model may lean on a short authored
label far more than Claude does.

**Arms.** Three, from Run 1/2's seed (`--reuse-seed`, not reseeded), order seed 12345, all 240 queries:

| arm | 判断 | what the judge reads | knob |
|---|---|---|---|
| `formula` | off | — | none |
| `lc:gemma-3-1b-it-Q4_K_M` | llama.cpp · gemma | content alone — the shipped default | none: must print no `[measurement]` line |
| `lcb:gemma-3-1b-it-Q4_K_M` | llama.cpp · gemma | `topic — content` | `GATHERLIGHT_JUDGE_INPUT=both`: must announce `judge input = both` |

No Claude arm runs, so nothing here spends account quota. `formula` is the baseline, and its positions digest is
the check that this run started where Runs 1–2 did: equal to their `f661eb6a056e` means the same questions, in the
same order, of the same starting graph. That is what lets the chat judge be read beside Run 1's Claude judge and
Run 2's rerankers. Any cross-run pairing is context only and is computed afterwards by re-analysis
(`--report-only … --baseline=…`), which calls no model. It is not part of the decision.

**How each chat arm is wired: exactly as the product runs a local chat judge.** The arm's own `settings.json` binds
`memory.judgeSource = llama-cpp` and `judgeModel = gemma-3-1b-it-Q4_K_M`. Its resources folder holds empty stand-ins
for the runtime and the GGUF, which is all `IsConfigured` asks, and `GATHERLIGHT_LLAMACPP_URL` points it at ONE shared
real router, which it adopts. That router is launched with the section the product writes for a CHAT model:
`n-gpu-layers = 99` and nothing else (`LlamaServerRuntime.WritePresets` puts `embeddings`, `reranking` and the
4096 batch sizes on the other kinds only). `--models-max` covers every model the bench serves. A chat judge both
annotates and verifies on llama.cpp, and a reused seed writes nothing, so neither arm should make a single
claude-cli call. The bench counts them and warns on any. The verifier's request names no sampling temperature, so
gemma samples at llama-server's default and its verdicts vary between identical runs, as the product's do.

**Model and machine.** `gemma-3-1b-it-Q4_K_M` is `GgufCatalog.RecommendedJudge`; its sha256 `8ccc5cd1…a135` was
re-checked against the catalogue pin before the run. llama.cpp `b10549` (commit `b2e5e9b28`, Vulkan x64) is the
pinned build Run 2 used. The GPUs are an NVIDIA GeForce RTX 4080 Laptop GPU (12 GB) and an Intel Arc iGPU, both
visible to Vulkan. The preset offloads every layer and selects no device, as the product's does. The CPU is an
Intel Core Ultra 9 185H. An unrelated llama-server process stays resident on the machine throughout.

**Measured.** Per set and `all`: top-1, found@8, MRR, `judged`/`graph` and `endorsed`. `judged`/`graph` is verdict
coverage: the judge fails open, so a graph recall with no verdict is the formula's ranking under another name.
Also measured: the parallel mean and serial median latency (12 queries, verdict-carrying recalls only), llama.cpp
chat calls ok/failed and claude-cli calls per arm, and the estimated candidate text per recall. Comparisons are
paired per query, with McNemar's exact p and the Agresti–Min 95% interval for the net rate, as in Runs 1–2: `lc`
against `lcb` (the question), and each against `formula`.

**Decision rule**, the plan's verbatim: *if content-only is significantly worse than `both` (paired, p < 0.05) on
top-1 or found@8, STOP and ask the owner whether to scope the flip to the Claude arm; otherwise record the result
and keep the default.* How it is read, fixed now:

- **"Significantly worse"** means: on `all`, on either metric, the exact McNemar p is below 0.05 and `lc` trails
  `lcb` (c − b < 0, with b = `lcb` hit & `lc` miss). The bench's per-set veto does NOT cancel it. A stop-and-ask
  rule should err towards asking, so a significant `all` stops even if a set runs the other way, and the owner is
  shown both. A single set significant on its own while `all` is not does not trigger, because eight per-set tests
  at 0.05 raise false alarms by themselves. It is reported all the same.
- **Otherwise the default stays**, and the result is recorded as exactly one of three outcomes:
  - **Equivalent**: the 95% interval on `all` lies inside ±3pp on BOTH metrics, Run 1's bar. Content alone then
    costs this judge nothing this fixture can show, and Run 1's conclusion extends to it.
  - **No significant difference**: on at least one metric, neither a finding nor equivalent. The run could not
    show a harm, and could not rule out one as large as the interval's lower bound, which is quoted with it. The
    default stays, because the question is whether to REVERT an owner-approved default, and that needs a measured
    harm. This is the opposite burden from Run 1, whose rule kept the old behaviour when undecided, because
    removing a feature needs evidence.
  - **`lc` significantly better**: recorded, and the default stays.
- **Two vacuity guards, checked before `lc` is read against `lcb`** (dev-conventions' measuring rule 1: can the
  instrument express the effect?):
  - *Verdict coverage.* If the smoke run (`--n=10`: 40 queries, the same arms) shows either chat arm giving verdicts
    on fewer than half its graph recalls, the full run is not made. A 1B judge that cannot produce a verdict is
    itself the finding, and its two arms would be the formula arm under two names. In the full run, coverage below
    98% raises the bench's own WARNING, and the result is reported with it.
  - *Does the judge move anything?* If neither chat arm differs from `formula`, i.e. both are equivalent to it on
    both metrics, then any content-against-both "equivalence" is vacuous: two ways of feeding a judge that changes
    nothing. It is recorded as that, not as evidence that the topic is not needed.
- **No judge A/A twin runs**; the arm list is the plan's. Nothing in this run sizes how far a sampling 1B judge
  wanders between identical runs (Run 1's Claude A/A differed by 2 of 240). The exact test stays valid without
  one, since under the null sampling noise splits discordant pairs evenly, but a gap of a few queries should be
  read against that.

## Run 3 — the local chat judge (2026-09-24, llama.cpp b10549; claude 2.1.281, never called)

**Command**

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=gemma-3-1b-it-Q4_K_M \
  --resources=devtools/_rr-res --port-base=5620 --llama-port=5640 > devtools/_judge-bench-lc.txt 2>&1
```

The design above was committed as `48568a8` before anything ran. The arm pair ran from the working tree that
became `7932445`; that commit differs from what ran by one space. `--resources` pointed at the same scratch folder
as Run 2, never at a household's data folder. The two port flags keep off every tcp range Windows had reserved
that day and off the band the shifted e2e runner uses. The smoke run (`--n=10`, same arms) passed the coverage
guard: 35/39 and 36/39 graph recalls judged.

**Seed**: Run 1's, reused (created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`, fixture
sha256 `9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555`). App HEAD `426be89` (v1.3.0). Order seed
**12345** (240 queries, 0 same-fact adjacencies), **3 arms in parallel**, latency sample 12 queries. Formula positions
digest **`f661eb6a056e`**, **equal to Runs 1 and 2**: the three runs asked the same questions, in the same order, of
the same starting graph. Every non-vacuity check held. `lcb` announced `judge input = both`, and `lc` printed no
`[measurement]` line. Both chat arms read back 判断 running `llama-cpp · gemma-3-1b-it-Q4_K_M` with no startup
warnings. No arm made a claude-cli call at startup or at any time in the run (0/0 in every row below). The shared
router ran with `--models-max 2` and a preset of exactly `[gemma-3-1b-it-Q4_K_M]` / `n-gpu-layers = 99`.

### Accuracy — the four sets and `all`

```
== same ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         42/60     54/60     0.769   243            
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    60     59      59        20/60     48/60     0.447   630            -22 / -6 / -0.322
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    60     43      43        24/60     51/60     0.521   953            -18 / -3 / -0.248

== cross ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         1/60      6/60      0.042   292            
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    60     47      47        1/60      4/60      0.029   762            +0 / -2 / -0.013
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    60     46      46        1/60      7/60      0.037   1018           +0 / +1 / -0.005

== third ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    55     0       0         1/60      18/60     0.119   246            
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    55     44      44        2/60      14/60     0.085   691            +1 / -4 / -0.034
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    55     37      37        2/60      16/60     0.093   669            +1 / -2 / -0.026

== mixed ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    59     0       0         35/60     47/60     0.657   289            
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    59     52      52        10/60     45/60     0.318   724            -25 / -2 / -0.339
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    59     50      50        17/60     47/60     0.407   686            -18 / +0 / -0.250

== all ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               240  0    234    0       0         79/240    125/240   0.397   268            
local chat judge gemma-3-1b-it-Q4_K_M · content only     240  0    234    202     202       33/240    111/240   0.220   702            -46 / -14 / -0.177
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  240  0    234    176     176       44/240    121/240   0.265   832            -35 / -4 / -0.132
```

### Paired — content only against topic — content (the question)

`b` = `lcb` (topic — content) hit & `lc` (content only) miss, `c` = the reverse. A negative net means content
alone did worse.

```
  top-1:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-1b-it-Q4_K_M vs lcb:gemma-3-1b-it-Q4_K_M  all     240    23/12    0.090   -11 (-4.6pp)     [-9.4, +0.3]pp      no          no
                                                       same    60     8/4      0.388   -4 (-6.7pp)      [-17.7, +4.8]pp     —           
                                                       cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                       third   60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —           
                                                       mixed   60     12/5     0.143   -7 (-11.7pp)     [-24.4, +1.8]pp     —           
  found@8:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-1b-it-Q4_K_M vs lcb:gemma-3-1b-it-Q4_K_M  all     240    18/8     0.076   -10 (-4.2pp)     [-8.3, +0.0]pp      no          no
                                                       same    60     4/1      0.375   -3 (-5.0pp)      [-12.5, +2.8]pp     —           
                                                       cross   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                       third   60     6/4      0.754   -2 (-3.3pp)      [-13.7, +7.2]pp     —           
                                                       mixed   60     5/3      0.727   -2 (-3.3pp)      [-12.7, +6.2]pp     —           
```

The found@8 interval's upper end, printed `+0.0`, is +0.04pp: it includes zero, barely.

### Paired vs `formula` — McNemar exact, per query

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    51/5     <0.001  -46 (-19.2pp)    [-24.6, -13.4]pp    no          YES (arm worse)
                                                           same    60     23/1     <0.001  -22 (-36.7pp)    [-48.6, -22.4]pp    —           
                                                           cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                           third   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —           
                                                           mixed   60     26/1     <0.001  -25 (-41.7pp)    [-53.7, -26.9]pp    —           
  local chat judge gemma-3-1b-it-Q4_K_M · topic — content  all     240    40/5     <0.001  -35 (-14.6pp)    [-19.6, -9.3]pp     no          YES (arm worse)
                                                           same    60     20/2     <0.001  -18 (-30.0pp)    [-42.4, -15.7]pp    —           
                                                           cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —           
                                                           third   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —           
                                                           mixed   60     19/1     <0.001  -18 (-30.0pp)    [-41.6, -16.5]pp    —           
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    17/3     0.003   -14 (-5.8pp)     [-9.4, -2.1]pp      no          YES (arm worse)
                                                           same    60     7/1      0.070   -6 (-10.0pp)     [-18.9, -0.5]pp     —           
                                                           cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                           third   60     6/2      0.289   -4 (-6.7pp)      [-15.8, +2.9]pp     —           
                                                           mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  local chat judge gemma-3-1b-it-Q4_K_M · topic — content  all     240    13/9     0.523   -4 (-1.7pp)      [-5.5, +2.2]pp      no          no
                                                           same    60     4/1      0.375   -3 (-5.0pp)      [-12.5, +2.8]pp     —           
                                                           cross   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —           
                                                           third   60     5/3      0.727   -2 (-3.3pp)      [-12.7, +6.2]pp     —           
                                                           mixed   60     3/3      1.000   +0 (+0.0pp)      [-8.4, +8.4]pp      —           
```

### Latency, llama.cpp calls and candidate-text size

```
latency (ms) — parallel: mean over the accuracy pass, 3 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                      ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)               268            219                 0/0                       0/0                    off · claude-cli · haiku
local chat judge gemma-3-1b-it-Q4_K_M · content only     702            403                 0/0                       0/0                    on · llama-cpp · gemma-3-1b-it-Q4_K_M
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  832            480                 0/0                       0/0                    on · llama-cpp · gemma-3-1b-it-Q4_K_M

llama.cpp chat calls (router: llamacpp) — ok/failed per pass; a local chat judge's verdicts arrive through these
arm                                                      startup     accuracy pass   latency pass
local chat judge gemma-3-1b-it-Q4_K_M · content only     0/0         234/0           12/0
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  0/0         234/0           12/0

candidate text per recall (estimated; 60 candidates at most — the engine gathers only what matches or links; numbering, instructions and the query are excluded, and chars ≠ tokens):
  local chat judge gemma-3-1b-it-Q4_K_M · content only     up to ~2517 chars (42 per candidate)
  local chat judge gemma-3-1b-it-Q4_K_M · topic — content  up to ~3306 chars (55 per candidate)
```

### Warnings

```
WARNING: arm lc:gemma-3-1b-it-Q4_K_M — judge failed open on 32/234 graph recalls
WARNING: arm lc:gemma-3-1b-it-Q4_K_M — 3/12 graph-ranked latency recalls carried no verdict (left out of its serial median)
WARNING: arm lcb:gemma-3-1b-it-Q4_K_M — judge failed open on 58/234 graph recalls
WARNING: arm lcb:gemma-3-1b-it-Q4_K_M — 1/12 graph-ranked latency recalls carried no verdict (left out of its serial median)
```

Every one of the 234 chat calls per arm returned `Ok`, so no missing verdict was a transport failure. Each was a reply
the verifier could not read as one, and it therefore left the engine's page alone (fail-open). Verdict coverage is
**86.3%** for `lc` (202/234) and **75.2%** for `lcb` (176/234): above the design's 50% guard, below the bench's 98%
bar, so both arms carry the warning. No other warning fired, and none about the CLI.

### The decision rule, applied

- **Significantly worse? No.** Content only trails `topic — content` on `all` on both metrics, but neither reaches
  p < 0.05: top-1 23/12, p = 0.090, net −11 = −4.6pp; found@8 18/8, p = 0.076, net −10 = −4.2pp. **The STOP is not
  triggered.**
- **Equivalent? No.** The 95% intervals, [−9.4, +0.3]pp for top-1 and [−8.3, +0.04]pp for found@8, reach far past
  −3pp.
- **The recorded outcome is therefore "no significant difference".** The run could not show that content alone
  hurts this judge. It also cannot rule out a harm as large as ~9pp on top-1 or ~8pp on found@8, and both point
  estimates lean that way. Every set in which the arms disagree at all leans the same way, and none is significant
  on its own. Per the rule, **the default stays content alone**.
- **Vacuity guards.** (1) Coverage 86.3% / 75.2% cleared the 50% guard. (2) The judge moves the ranking, significantly
  and downward (next section), so the comparison is not two ways of feeding a judge that changes nothing.

### What it says

- **Content only against topic — content: a lean, not a finding, and partly an artefact of abstaining.** The
  numbers are in the section above. What they hide is that the two arms do not judge equally often. `lcb` failed to
  give a verdict on 58 graph recalls against `lc`'s 32. A recall with no verdict keeps the engine's page, and on this
  fixture the engine's page is better than this judge's (next bullet). So part of `lcb`'s lead is `lcb` abstaining
  more. *Post hoc, not pre-registered, and not used for the decision*: on the 157 graph recalls where both arms gave
  a verdict, the gap shrinks to −3.8pp on both metrics (top-1 14/8, p = 0.286; found@8 13/7, p = 0.263). The longer
  `topic — content` input is also the one that more often produced an unreadable reply, which is a property of that
  input with this model, not noise.
- **The larger finding: this judge makes recall WORSE than no judge.** Against 公式 with no verification, both
  arms are significantly worse on top-1. Content only goes 79 → 33/240 (51/5, p < 0.001, **−19.2pp**, [−24.6, −13.4]pp),
  and topic — content goes 79 → 44 (40/5, p < 0.001, **−14.6pp**, [−19.6, −9.3]pp). The loss is in the two sets where
  the formula already puts the answer first most of the time: `same` (−36.7 / −30.0pp) and `mixed` (−41.7 / −30.0pp),
  all four p < 0.001. `cross` and `third` barely move, because the formula has almost nothing there to lose (1/60
  first). On found@8, content only is also significantly worse (17/3, p = 0.003, −5.8pp), while topic — content is
  not a finding (13/9, p = 0.523). The mechanism is the partition, and it is the failure Lyntai's
  `LlmVerificationOptions` documentation warns of ("a judge can be WORSE than no judge"). gemma endorsed at least one
  candidate on every recall it judged (`endorsed` = `judged` in every set), and partition promotes whatever is
  endorsed ahead of the engine's ranking. *Post hoc*: on the 202 recalls where content only gave a verdict, its
  top-1 is −22.8pp against 公式 (51/5). On the 32 where it gave none, its top-1 matches 公式's (0/0).
- **Beside the other judges on the same seed and questions (digest `f661eb6a056e` in all three runs; quoted from the
  tables, not paired here).** top-1 / found@8 of 240: 公式 79 / 125; Claude judge (Run 1 `content`) 132 / 133;
  rerankers under partition (Run 2) 86–90 / 203–208; this local chat judge 33 / 111 (content only) and 44 / 121
  (topic — content). It is the only judge measured here that loses to having none.
- **Latency.** Serial medians are **403 ms** for content only and **480 ms** for topic — content, against **219 ms**
  for 公式. A verdict therefore adds ~0.18 s and ~0.26 s per recall. Content only's cost is in line with the
  0.15–0.20 s per call quoted for this model, and the longer `topic — content` input costs more. Content only's
  candidate text is ~24% smaller (up to ~2517 against ~3306 chars). The parallel means
  (702 / 832 ms) were contended: three arms at once, two of them on one router and one GPU.

### What it does NOT say

- One fixture (60 invented facts), one run per arm, ONE chat model (the 1B at Q4), one llama.cpp build (`b10549`,
  Vulkan) on one machine. Nothing here says how `gemma-3-4b-it-Q4_K_M` or any other local chat model would do. In
  particular it does not say that a larger local judge also loses to 公式, only that this one does.
- No judge A/A twin ran, and the judge samples at llama-server's default temperature. Nothing in this run sizes how
  far its verdicts wander between identical runs. Whether noise alone could produce the lc/lcb gaps (10–11 queries)
  is exactly what an A/A pair would have shown. Run 1's Claude A/A differed by 2.
- Partition only, the product default. Fuse, which exists to soften a verdict that replaces the page, was not
  measured for this judge. Nothing here says whether it would recover the loss.
- The bench records WHETHER the judge endorsed anything, not which candidates or how many. That gemma endorses too
  much, or the wrong fact, is the mechanism's likely reading, not a measurement.
- Recall-time only. A local chat judge also ANNOTATES every fact write on llama.cpp; a reused seed writes nothing, so
  every arm recalled against subject tags the Claude CLI wrote when the seed was made. A household on this judge
  has tags written by gemma instead, and that configuration was not measured.
- 语义 was off, as in Runs 1 and 2. Kind-filtered recalls (up to 400 candidates) were not exercised, and nothing here
  prices a longer candidate list for a 1B model.
- "No significant difference" is not "content alone is as good". The run did not show content alone worse; it did
  not show it equivalent either.

## Run 4 — smaller rerankers (design)

Written and committed BEFORE the run; the results section that follows names this commit. The screen below ran
first, because its results decide which arms exist.

**The question.** Run 2 found both catalogued rerankers, ~468 MB each, a large found@8 gain over 公式 (+34.6 /
+32.5pp). Run 3 found a 1B local CHAT judge worse than no judge. **Does a SMALLER multilingual reranker keep Run 2's
gain on this zh/en fixture?** Measurement and screening only: no product code or catalogue row changes here, and
whether to offer a model is the owner's decision after the results.

**Candidates.** From a survey by the Lyntai session, which recorded no checksums; every file below was fetched here and
hashed over the downloaded bytes, and each sha256 equals the repo's own LFS sha256 (and, for the two controls, the
`GgufCatalog` pin). All sit flat in `devtools/_rr-res/gguf/<id>.gguf`, the scratch folder Runs 2–3 used.

| id in this run | role | uploader / repo @ commit | upstream file | bytes | sha256 |
|---|---|---|---|---|---|
| `bge-reranker-v2-m3-Q5_K_M` | control (`RecommendedReranker`) | `gpustack/bge-reranker-v2-m3-GGUF` @ `3093af03b1a635e67b084b1d8c03c5f5e020fd05` | `bge-reranker-v2-m3-Q5_K_M.gguf` | 468,392,352 | `1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef` |
| `LAMAR-600m.Q5_K_M` | control | `mradermacher/LAMAR-600m-GGUF` @ `cd4da764d5b17d9996710dbf0ef5ad31c9aed182` | `LAMAR-600m.Q5_K_M.gguf` | 468,393,760 | `ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f` |
| `mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0` | candidate (b) | `keisuke-miyako/mmarco-mMiniLMv2-L12-H384-v1-gguf-q8_0` @ `2b37d162c88e0aeb8a1b4acb2d50f0e5ade16fd5` | `mmarco-mMiniLMv2-L12-H384-v1-Q8_0.gguf` | 132,584,000 | `91d70301828ba735c22eda56adb649f48975f371337e8c8b046326b885e26eed` |
| `xVITA-Rerank-300M-zhTW-Q8_0` | candidate (c) | `xCloudinfo/xVITA-Rerank-300M-zhTW-GGUF` @ `dde8353a0c48b9283b6b81fe73730cc4724fd517` | `xVITA-Rerank-300M-zhTW-Q8_0.gguf` | 332,894,432 | `f894c75201a42073ab71c678a21b56b74a9fa16dee31069e51ece7b50faf9ef1` |
| `Qwen3-Reranker-0.6B-Q6_K` | reference (d), NOT a size reduction | `Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp` @ `eb9ad47d4e53c2a6abd6158b505f1539d1c5650c` | `Qwen3-Reranker-0.6B-Q6_K.gguf` | 494,879,136 | `5916ab2926388177a0a7b6eedfd909d214a29592ce35153a7d9ff86c08e4b99e` |

- **(b)** is the Q8_0 of `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` whose size the survey quoted (132,584,000 B); the
  same uploader's Q4_K_M is 124,925,504 B (`8423df36771089765e2163e93c79ef6b4afdd9117cb76c6df073b5a6f6bdfc52`), not used.
  Of the other Hugging Face GGUFs under that name, `mono-of-pg`'s converts the BASE encoder
  (`mMiniLMv2-L12-H384-distilled-from-XLMR-Large`, no ranking head) and `Gramscii-IT`'s is an F16 (242,628,704 B).
  **It is renamed**: the upstream filename carries no "rerank", and the app types an uncatalogued GGUF by NAME
  (`ResourceProvisioner.GgufKind`: "rerank" → reranker, otherwise chat), so under its own name the app would wire it
  as a CHAT judge. That is a hazard for a household dropping the file in, which a catalogue row would remove; this run
  does not measure it.
- **(d)** Voodisss's file is byte-identical to `zhiqian99/Qwen3-Reranker-0.6B-GGUF-llama_cpp`'s (same LFS sha256,
  repo @ `3639495043fbaf457e6808417a56d6e2d010f7cb`). `mradermacher`'s Q6_K (494,877,024 B, `a68c0e45…`) was not used:
  that is the conversion missing `cls.output.weight` (llama.cpp #16407). At 494,879,136 B, (d) is LARGER than either
  control, and it runs as a reference only.

### The screen (2026-09-24, before this design)

Each model ran on its own `llama-server`: llama.cpp **b10549**, commit `b2e5e9b28`, published 2026-08-21, Vulkan x64,
the build the product pins. It got the flags the product's preset gives a reranking child: `--reranking`, `-ngl 99`,
and `--ctx-size`/`--batch-size`/`--ubatch-size 4096`. Each had its own port, was killed by PID, and its port was
re-checked free. The instrument is `devtools/_rr-screen/screen.mjs` (scratch, untracked; its JSON sits beside it).

**Headers**, read from each file before it was served:

| model | `general.architecture` | `tokenizer.ggml.token_type_count` | context_length | tensors | head / pooler tensors as present | tokenizer |
|---|---|---|---|---|---|---|
| BGE | `bert` | 1 | 8192 | 393 | `cls.weight` [1024,1024], `cls.bias`, `cls.output.weight` [1024], `cls.output.bias` [1] | `t5` (SentencePiece unigram), 250,002 |
| LAMAR | `bert` | 1 | 8192 | 393 | as BGE | `t5`, 250,002 |
| mMiniLM | `bert` | 1 | **512** | 201 | `cls.weight` [384,384], `cls.bias` [384], `cls.output.weight` [384], `cls.output.bias` [1] | `t5`, 250,002 |
| xVITA | `modern-bert` | absent (no token-type tensor at all) | 8192 | 138 | `cls.weight` [768,768], `cls.norm.weight` [768], `cls.output.weight` [768], `cls.output.bias` [1] | `llama` (SentencePiece, Gemma vocab), 256,000 |
| Qwen3 | `qwen3` | absent | 40960 | 311 | `cls.output.weight` [1024,2], labels `yes`/`no`; rerank template present | `gpt2` (`qwen2` pre-tokenizer), 151,669 |

llama.cpp's converter types an XLM-RoBERTa model `bert`. `token_type_count = 1` is what marks the three XLM-R files
(BGE, LAMAR, mMiniLM) as RoBERTa-family, which puts them outside llama.cpp #21729: that bug zeroes segment ids and so
degrades a two-segment BERT cross-encoder. No file has a `pooler` tensor. `pooling_type` is absent from the three
`bert` files and from xVITA's (the server's `--reranking` sets rank pooling), and is 4 (rank) in Qwen3's.

**Screen results.** Two pairs were scored.

- **(i)** is the app's own pair, `LlamaCppSource.ScreenQuery` / `ScreenDocuments`. The answer is SECOND in input
  order, and the distractor shares more of the query. It is asserted exactly as `ScreenRerankerAsync` asserts it: the
  answer strictly ahead.
- **(ii)** is the model-card pair of `cross-encoder/ms-marco-MiniLM-L6-v2`: "How many people live in Berlin?", sent
  with its query, in the card's wording (`Berlin had a population …`). The published scores are
  `[8.607138, -4.320078]`, a spread of 12.9272. ORDER is asserted; the values are reported.

Scores are each model's first call; every pair was sent three times.

| model | loads on b10549 | served context per slot | (i) [distractor, answer] | (i) | (ii) [relevant, on-topic] | spread · ours / 12.9272 | (ii) | max drift, 3 calls |
|---|---|---|---|---|---|---|---|---|
| BGE | yes | 4096 | 1.758777, 5.162949 (+3.404171) | pass | 5.783929, −8.213037 | 13.996965 · 1.083 | pass | 0.0055 |
| LAMAR | yes | 4096 | 3.532229, 7.663852 (+4.131623) | pass | 6.158854, −7.706760 | 13.865614 · 1.073 | pass | 0.0069 |
| mMiniLM | yes | **512** | −2.525820, 9.292150 (+11.817970) | pass | 10.712934, −4.176289 | 14.889222 · 1.152 | pass | 0.0073 |
| xVITA | yes | 4096 | 10.018924, 7.419926 (**−2.598998**) | **FAIL** | 3.385730, −5.605216 | 8.990946 · 0.696 | pass | 0.0115 |
| Qwen3 | yes | 4096 | 0.999039, 0.999779 (+0.000740) | pass | 0.998495, 0.001490 | 0.997005 in probability, not a logit | pass | 0 |

- (i) gave identical scores on all three calls for every model. The Berlin pair was also ordered for every model in
  the brief's wording (`Berlin has a population …`).
- **Qwen3's scores are PROBABILITIES**, because llama.cpp takes the softmax of the `yes`/`no` head. A spread measured
  against a logit reference therefore means nothing, and a "collapsed spread" rule would misfire on it. In logit
  terms its (i) margin is 8.415 − 6.946 = 1.469 and its Berlin spread 13.005. Its (i) margin of 0.00074 is saturated
  near 1.0.
- **xVITA stops here: it fails (i).** It ranks the distractor that repeats the question above the answer that states
  the price, identically on all three calls. The product's bind screen asserts exactly this ordering, so binding it
  would be refused with 「没有通过重排自检:答案没有排在前面」. That is the sentence `ScreenRerankerAsync` returns, derived
  from the code, not driven through the app. Three diagnostics were run, and none changes the verdict:
  - The same pair in Traditional characters (it is a zh-TW model) fails too: 10.727221 vs 7.127617.
  - With the answer placed FIRST in input order, the scores are unchanged (7.419926 vs 10.018924), so it is not echoing
    input order.
  - Its own model card's example comes out ordered: −7.756561 vs 2.153190.

  It loads and it serves, but on the one pair built to catch it, it prefers lexical overlap. `modern-bert` does load
  on b10549, so the model card's "2026-08 or later" requirement holds.
- **Supplementary, not a gate**: Lyntai's four-document Apollo fixture. The answer came first for all five models.
  The unrelated document came last for BGE, LAMAR and Qwen3, but not for mMiniLM (bread −9.229800, just above the
  lunar eclipse at −9.697894) nor for xVITA (bread −7.305520, above both on-topic distractors).

**The 512-token question.** It concerns mMiniLM only; the other four serve 4096-token slots.

llama.cpp serves mMiniLM with 512-token slots whatever the preset asks. It logs
`n_ctx_seq (4096) > n_ctx_train (512) -- possible training context overflow`, then `n_ctx_slot = 512`. So the
product's reranker preset LOADS it unchanged. A pair is formatted as query + document + 4 special tokens; that count
was read back from the server's own figure in its refusal. Measured on the served model with `/tokenize`:

- **Over-long input.** 1,360 Chinese characters (1,041 tokens), sent beside a short document, got
  `400 input (1052 tokens) is larger than the max context size (512 tokens). skipping`. The WHOLE call was refused
  and the short document went unscored too, which the fail-open verifier turns into no verdict.
- **The shipped cap.** `RerankInputCap.MaxChars` allows 1,000 characters; of common Chinese that is 770 tokens, and
  the pair got `400 input (781 tokens) is larger than the max context size (512 tokens). skipping`. With the screen's
  7-token query, at most 650 characters of that text fit. **So at the shipped cap, this model would refuse every
  recall that surfaces a long fact.** English is about 4× cheaper: 1,000 characters is 238 tokens.
- **This fixture.** The longest fact is 101 characters / 29 tokens, the longest question 164 characters / 39 tokens,
  and the longest pair 72 tokens. **0 of 14,400** question × fact pairs exceed 512. The seed database holds exactly
  the 60 fixture facts (content ≤ 101 characters, topic ≤ 31).
- **On this tokenizer, characters bound tokens.** On every string tested, tokens ≤ UTF-16 units + 1 (the +1 is a
  leading `▁`). The test covered:
  - 20 adversarial strings: rare CJK inside and outside the BMP, emoji sequences, kana, hangul, Arabic, Devanagari,
    Thai, Cyrillic, spaced letters, spaced CJK, digits, full-width characters, punctuation, whitespace runs,
    code-switched text, zero-width and combining marks, and control characters;
  - every prefix of eight of them;
  - all 300 fixture strings.

  So a CHARACTER cap is a hard bound for this model family, not an estimate. That holds for SentencePiece without byte
  fallback, and would NOT transfer to a byte-level tokenizer.

### Fitted input — requested for this run, and not in it

After the screen, the owner allowed the input design itself to change. A candidate whose only problem is the 512-token
context is not to be rejected for it; it is to be measured with its input FITTED to the model. The request had two
parts:

- a measurement knob in `RerankInputCap`, `GATHERLIGHT_RERANK_INPUT_CAP=<chars>`, announced like the other judge knobs
  and pinned blank in the bench;
- fitted-cap arms for mMiniLM, and for both controls at the same cap.

**The product-code change was not permitted in this session, so no fitted-cap arm runs.** It would not have changed a
single input on this fixture, which is why the question is still answerable:

- **The fitted cap would have been 400 characters.** 512 − 4 special tokens − 39 (the fixture's longest question) −
  1 (the prefix bound above) leaves 468. Rounding down to 400 leaves room for a query of up to 107 tokens.
- **No candidate here is long enough to be cut.** Every candidate this run can show a reranker is ≤ 101 characters,
  so any cap ≥ 101 cuts nothing. A fitted-cap arm would have been sent byte-identical documents to the shipped-cap arm
  of the same model.
  - **For mMiniLM, the shipped-cap arm IS its fitted-input arm on this fixture.**
  - For BGE and LAMAR, capped arms would have been identical-input twins: a run-to-run noise check, not a measure of
    what the cap costs.
- **What a cap COSTS needs facts longer than it.** This fixture has none, and a long-fact fixture needs a reseed:
  Claude annotation calls, which is quota this run may not spend. That is a stated gap, not a result.

### Arms, command and configuration

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,formula2 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M,LAMAR-600m.Q5_K_M,mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0,Qwen3-Reranker-0.6B-Q6_K \
  --resources=devtools/_rr-res --port-base=5620 --llama-port=5660 > devtools/_judge-bench-rr4.txt 2>&1
```

Ten arms run in ONE run, so every comparison is paired within it:

- `formula`, and its engine A/A twin `formula2`;
- a partition (`rr:`) arm and a fuse (`rrf:`) arm per reranker.

xVITA does not run, because it failed (i). No Claude arm runs, and the seed is the one Runs 1–3 used, reused. The bench
is unchanged. It writes the product's reranker preset for every reranker, mMiniLM included; the screen showed that
llama.cpp accepts that preset for mMiniLM and serves it at 512.

**Every arm's configuration.** It is stated because a reranker's gain does not transfer without the configuration it
was measured in.

- **Base:** this run's `formula` arm, i.e. 公式 with no verification, over the seed's CLI-written subject tags. In
  Runs 1–3 that arm read 79/240 top-1 and 125/240 found@8. Every Δ in the results is taken against THIS run's row.
- **Embedder: none.** 语义 is unbound (the seed's `settings.json` has no memory section). There is therefore no vector
  store and no semantic seed channel, and candidates come from the graph and FTS trigram alone.
- **`EndorseCount` = 8** (`RecallFactsTool.DefaultRecallLimit`). That is also the page size (`limit 8`).
- **Candidates:** at most 60 per recall, since the corpus holds 60 facts.
- **Input and combination:** each reranker sees the candidates through `RerankInputCap` at the shipped 1,000
  characters, under partition (`rr:`) or fuse (`rrf:`).

**Measured**, as in Run 2:

- per set and on `all`: top-1, found@8, MRR, `judged`/`graph` and `endorsed`;
- the serial median latency (12 queries, counting only recalls that carried a verdict), and the parallel mean;
- claude-cli calls per arm;
- for every reranker, against `formula` and against every other reranker: the paired McNemar exact p and the
  Agresti–Min 95% interval.

### Decision rule

A candidate is **viable for the owner to consider** when all three of these hold:

1. **It screens correctly.** It loads on b10549 and passes (i) and (ii). This is already applied: mMiniLM and Qwen3
   pass, xVITA does not.
2. **No call fails on this fixture.** `judged` must equal `graph` in every set, in both of its arms. A reranker abstains
   only on a fault, and the bench warns on any abstention.
   - Every abstention is traced to its cause in the arm's log and the router log. One caused by over-long input
     disqualifies, and so does any other failure.
   - mMiniLM is judged at its fitted input, which on this fixture is its shipped-cap arm (see above). Its failure at
     the SHIPPED cap on long facts is an integration requirement the results will state, not a disqualification.
3. **found@8 is NOT significantly worse than BGE.** The comparison is partition against partition, on `all`, within
   this run. The candidate fails this rule if and only if the exact McNemar p < 0.05 AND c − b < 0, where
   b = `rr:bge-reranker-v2-m3-Q5_K_M` hit & candidate miss. The bench's per-set veto does not rescue a candidate.

For a viable candidate, the found@8 result against BGE is recorded as exactly one of these:

- **equivalent**: the 95% interval on `all` lies inside ±3pp;
- **no significant difference**: neither worse nor equivalent. "Not significantly worse" is not "equivalent", so the
  interval's lower bound is quoted as the loss the run cannot rule out;
- **significantly better**.

Reported beside it, outside the rule: top-1 against BGE, both metrics against `formula` and against LAMAR, serial and
parallel latency, and exact bytes.

- **"Keeps Run 2's gain"** is how the question words it. It means: the candidate is viable, AND its partition arm's
  found@8 is a finding over `formula` in this run (p < 0.05, better).
- **Multiplicity.** Each candidate is tested against BGE at 0.05, with no correction. That errs towards calling a
  candidate worse, which is the conservative direction for a rule whose output is "worth considering".
- **Qwen3 is a reference.** The rule is applied to it for completeness, but a model larger than both controls cannot
  answer a question about smaller ones.

**Guards**, checked before any candidate is read:

- **The formula digest.** The `formula` positions digest must equal **`f661eb6a056e`**, as in Runs 1–3. If it does
  not, the within-run pairing still stands, but no number here may be set beside another run's.
- **The engine A/A pair.** `formula` against `formula2` must be quiet on `all` (p ≥ 0.05), or the run is suspect.
- **Every reranker arm's startup.** Each must read back 判断 running `llama-cpp · <its id>`, raise no startup warning,
  and make no claude-cli call. The bench enforces the first two at startup and warns on the third.
- **Kind.** Both uncatalogued ids contain "rerank", so the app types them as rerankers. The router log must show each
  model served. A model wrongly typed as chat would abstain on every recall and so fail rule 2.
- **Can the instrument express the 512 failure? No.** With 0 of 14,400 pairs over 512 tokens, a clean mMiniLM row says
  nothing about long facts. That evidence comes from the screen, never from this run.
- **No reranker A/A pair.** The bench runs each model once per list. As context outside the decision, a re-analysis
  pairs this run's BGE with Run 2's (the same configuration and seed, and the same digest if the guard holds). That is
  the nearest thing to a model A/A this data has.

## Run 4 — smaller rerankers (2026-09-24, llama.cpp b10549; claude 2.1.281, never called)

**Command**, as registered:

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,formula2 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M,LAMAR-600m.Q5_K_M,mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0,Qwen3-Reranker-0.6B-Q6_K \
  --resources=devtools/_rr-res --port-base=5620 --llama-port=5660 > devtools/_judge-bench-rr4.txt 2>&1

node devtools/dev.mjs judge-bench --report-only=devtools/_judge-bench/results-2026-09-24T023624.720Z.json \
  --baseline=devtools/_judge-bench/results-2026-09-23T113455.224Z.json:rr:bge-reranker-v2-m3-Q5_K_M \
  > devtools/_judge-bench-rr4-vs-run2-bge.txt 2>&1
```

The design above was committed as `1d10235` before anything ran, and the run's app HEAD is that commit (v1.3.0). The
bench is unchanged since Run 3, the server binary was built from this HEAD's sources, and no product code changed. `--resources` pointed at the same
scratch folder as Runs 2–3, never at a household's data folder.

**Seed**: Run 1's, reused (created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`, fixture
sha256 `9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555`). Order seed **12345** (240 queries, 0
same-fact adjacencies), **10 arms in parallel**, latency sample 12 queries.

**Every guard held:**

- **The formula digest** is **`f661eb6a056e`**, equal to Runs 1–3.
- **The engine A/A pair** is byte-identical (p = 1.000 on every set).
- **Every reranker arm** read back 判断 running `llama-cpp · <its id>` with no startup warning, and made **0**
  claude-cli calls, at startup and over the whole run. The bench printed **no WARNING line**.
- **The router log** shows each of the four models spawned as its own child and proxied **494** requests each. That
  is 2 arms × 247: 234 graph recalls, 12 latency recalls and 1 warm. There is no error line and no truncation. The
  mMiniLM child logged `n_ctx_slot = 512`, and the largest pair any XLM-R child processed was 72 tokens (146 for Qwen3,
  whose rerank template wraps every pair).

### The headline

Partition arms, `all`, 240 queries. Every arm has the same configuration:

- **base**: this run's `formula`, at 79 / 125;
- **embedder**: none (语义 unbound);
- **`EndorseCount`**: 8 = the page;
- **candidates**: ≤ 60;
- **input**: `RerankInputCap` at the shipped 1,000 characters, which cuts nothing on this fixture.

| arm (partition) | bytes | top-1 | found@8 | Δ vs 公式 (top-1 / found@8) | found@8 vs BGE, paired (b/c, p, net, 95%) | top-1 vs BGE, paired | serial median |
|---|---|---|---|---|---|---|---|
| 公式 (base) | — | 79 | 125 | — | — | — | 237 ms |
| BGE (control) | 468,392,352 | 90 | 204 | +11 / +79 | — | — | 447 ms |
| LAMAR (control) | 468,393,760 | 86 | 208 | +7 / +83 | 0/4, p = 0.125, +4 (+1.7pp), [−0.1, +3.5] | 7/3, p = 0.344 | 498 ms |
| **mMiniLM** | **132,584,000** | **99** | **199** | **+20 / +74** | **7/2, p = 0.180, −5 (−2.1pp), [−4.6, +0.5]** | **4/13, p = 0.049, +3.8pp** | **313 ms** |
| Qwen3 (reference) | 494,879,136 | 92 | 207 | +13 / +82 | 1/4, p = 0.375, +3 (+1.3pp), [−0.7, +3.2] | 4/6, p = 0.754 | 1,530 ms |

b = BGE hit & arm miss, c = the reverse. xVITA failed the screen and did not run.

### Accuracy — the four sets and `all`

```
== same ==
arm                                                            n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)                     60   0    60     0       0         42/60     54/60     0.769   325
公式 · no verification · A/A twin                              60   0    60     0       0         42/60     54/60     0.769   323            +0 / +0 / +0.000
reranker bge-reranker-v2-m3-Q5_K_M · partition                 60   0    60     60      60        43/60     57/60     0.808   967            +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      60   0    60     60      60        42/60     55/60     0.790   994            +0 / +1 / +0.021
reranker LAMAR-600m.Q5_K_M · partition                         60   0    60     60      60        42/60     57/60     0.795   958            +0 / +3 / +0.027
reranker LAMAR-600m.Q5_K_M · fuse                              60   0    60     60      60        42/60     55/60     0.785   940            +0 / +1 / +0.017
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  60   0    60     60      60        46/60     57/60     0.835   559            +4 / +3 / +0.066
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       60   0    60     60      60        42/60     54/60     0.792   505            +0 / +0 / +0.023
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  60   0    60     60      60        43/60     57/60     0.806   2466           +1 / +3 / +0.037
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       60   0    60     60      60        42/60     54/60     0.780   2487           +0 / +0 / +0.011

== cross ==
arm                                                            n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)                     60   0    60     0       0         1/60      6/60      0.042   400
公式 · no verification · A/A twin                              60   0    60     0       0         1/60      6/60      0.042   402            +0 / +0 / +0.000
reranker bge-reranker-v2-m3-Q5_K_M · partition                 60   0    60     60      60        3/60      48/60     0.220   1336           +2 / +42 / +0.178
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      60   0    60     60      60        2/60      12/60     0.071   1322           +1 / +6 / +0.030
reranker LAMAR-600m.Q5_K_M · partition                         60   0    60     60      60        1/60      49/60     0.174   1339           +0 / +43 / +0.133
reranker LAMAR-600m.Q5_K_M · fuse                              60   0    60     60      60        1/60      9/60      0.051   1343           +0 / +3 / +0.009
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  60   0    60     60      60        3/60      46/60     0.236   688            +2 / +40 / +0.194
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       60   0    60     60      60        1/60      14/60     0.076   661            +0 / +8 / +0.034
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  60   0    60     60      60        2/60      49/60     0.215   2866           +1 / +43 / +0.173
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       60   0    60     60      60        1/60      9/60      0.052   2830           +0 / +3 / +0.010

== third ==
arm                                                            n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)                     60   0    55     0       0         1/60      18/60     0.119   353
公式 · no verification · A/A twin                              60   0    55     0       0         1/60      18/60     0.119   352            +0 / +0 / +0.000
reranker bge-reranker-v2-m3-Q5_K_M · partition                 60   0    55     55      55        8/60      43/60     0.293   1138           +7 / +25 / +0.173
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      60   0    55     55      55        8/60      20/60     0.205   1141           +7 / +2 / +0.086
reranker LAMAR-600m.Q5_K_M · partition                         60   0    55     55      55        5/60      45/60     0.271   1180           +4 / +27 / +0.152
reranker LAMAR-600m.Q5_K_M · fuse                              60   0    55     55      55        5/60      22/60     0.190   1180           +4 / +4 / +0.071
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  60   0    55     55      55        12/60     40/60     0.324   530            +11 / +22 / +0.205
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       60   0    55     55      55        11/60     22/60     0.243   589            +10 / +4 / +0.123
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  60   0    55     55      55        8/60      44/60     0.306   2470           +7 / +26 / +0.186
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       60   0    55     55      55        7/60      23/60     0.201   2495           +6 / +5 / +0.082

== mixed ==
arm                                                            n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)                     60   0    59     0       0         35/60     47/60     0.657   395
公式 · no verification · A/A twin                              60   0    59     0       0         35/60     47/60     0.657   393            +0 / +0 / +0.000
reranker bge-reranker-v2-m3-Q5_K_M · partition                 60   0    59     59      59        36/60     56/60     0.712   1324           +1 / +9 / +0.055
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      60   0    59     59      59        35/60     51/60     0.681   1321           +0 / +4 / +0.024
reranker LAMAR-600m.Q5_K_M · partition                         60   0    59     59      59        38/60     57/60     0.731   1313           +3 / +10 / +0.074
reranker LAMAR-600m.Q5_K_M · fuse                              60   0    59     59      59        37/60     51/60     0.702   1319           +2 / +4 / +0.045
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  60   0    59     59      59        38/60     56/60     0.732   716            +3 / +9 / +0.075
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       60   0    59     59      59        38/60     51/60     0.715   709            +3 / +4 / +0.058
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  60   0    59     59      59        39/60     57/60     0.738   2468           +4 / +10 / +0.082
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       60   0    59     59      59        37/60     51/60     0.696   2472           +2 / +4 / +0.039

== all ==
arm                                                            n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)                     240  0    234    0       0         79/240    125/240   0.397   368
公式 · no verification · A/A twin                              240  0    234    0       0         79/240    125/240   0.397   368            +0 / +0 / +0.000
reranker bge-reranker-v2-m3-Q5_K_M · partition                 240  0    234    234     234       90/240    204/240   0.508   1191           +11 / +79 / +0.111
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      240  0    234    234     234       87/240    138/240   0.437   1194           +8 / +13 / +0.040
reranker LAMAR-600m.Q5_K_M · partition                         240  0    234    234     234       86/240    208/240   0.493   1198           +7 / +83 / +0.096
reranker LAMAR-600m.Q5_K_M · fuse                              240  0    234    234     234       85/240    137/240   0.432   1195           +6 / +12 / +0.035
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  240  0    234    234     234       99/240    199/240   0.532   623            +20 / +74 / +0.135
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       240  0    234    234     234       92/240    141/240   0.456   616            +13 / +16 / +0.059
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  240  0    234    234     234       92/240    207/240   0.516   2568           +13 / +82 / +0.119
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       240  0    234    234     234       87/240    137/240   0.432   2571           +8 / +12 / +0.035
```

### Paired vs `formula` — McNemar exact, per query

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
  top-1:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                              all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                                 same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  reranker bge-reranker-v2-m3-Q5_K_M · partition                 all     240    3/14     0.013   +11 (+4.6pp)     [+1.2, +7.9]pp      no          YES (arm better)
                                                                 same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                                 cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                                 third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                                 mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                      all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                                 same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                                 cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                                 third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                                 mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
  reranker LAMAR-600m.Q5_K_M · partition                         all     240    1/8      0.039   +7 (+2.9pp)      [+0.4, +5.4]pp      no          YES (arm better)
                                                                 same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
                                                                 mixed   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
  reranker LAMAR-600m.Q5_K_M · fuse                              all     240    1/7      0.070   +6 (+2.5pp)      [+0.1, +4.9]pp      no          no
                                                                 same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
                                                                 mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  all     240    3/23     <0.001  +20 (+8.3pp)     [+4.2, +12.3]pp     no          YES (arm better)
                                                                 same    60     2/6      0.289   +4 (+6.7pp)      [-2.9, +15.8]pp     —
                                                                 cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                                 third   60     0/11     <0.001  +11 (+18.3pp)    [+7.7, +27.8]pp     —
                                                                 mixed   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       all     240    5/18     0.011   +13 (+5.4pp)     [+1.5, +9.3]pp      no          YES (arm better)
                                                                 same    60     4/4      1.000   +0 (+0.0pp)      [-9.5, +9.5]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —
                                                                 mixed   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
  reranker Qwen3-Reranker-0.6B-Q6_K · partition                  all     240    3/16     0.004   +13 (+5.4pp)     [+1.8, +8.9]pp      no          YES (arm better)
                                                                 same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                                 cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                                 third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                                 mixed   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
  reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       all     240    4/12     0.077   +8 (+3.3pp)      [-0.0, +6.6]pp      no          no
                                                                 same    60     3/3      1.000   +0 (+0.0pp)      [-8.4, +8.4]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —
                                                                 mixed   60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —
  found@8:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                              all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                                 same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                 mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  reranker bge-reranker-v2-m3-Q5_K_M · partition                 all     240    0/79     <0.001  +79 (+32.9pp)    [+26.7, +38.6]pp    no          YES (arm better)
                                                                 same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                 cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —
                                                                 third   60     0/25     <0.001  +25 (+41.7pp)    [+27.7, +52.9]pp    —
                                                                 mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                      all     240    5/18     0.011   +13 (+5.4pp)     [+1.5, +9.3]pp      no          YES (arm better)
                                                                 same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                                 cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —
                                                                 third   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
                                                                 mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
  reranker LAMAR-600m.Q5_K_M · partition                         all     240    0/83     <0.001  +83 (+34.6pp)    [+28.3, +40.3]pp    no          YES (arm better)
                                                                 same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                 cross   60     0/43     <0.001  +43 (+71.7pp)    [+57.5, +81.3]pp    —
                                                                 third   60     0/27     <0.001  +27 (+45.0pp)    [+30.8, +56.3]pp    —
                                                                 mixed   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —
  reranker LAMAR-600m.Q5_K_M · fuse                              all     240    3/15     0.008   +12 (+5.0pp)     [+1.5, +8.4]pp      no          YES (arm better)
                                                                 same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                                 cross   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
                                                                 third   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
                                                                 mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  all     240    1/75     <0.001  +74 (+30.8pp)    [+24.6, +36.6]pp    no          YES (arm better)
                                                                 same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                 cross   60     0/40     <0.001  +40 (+66.7pp)    [+52.2, +76.8]pp    —
                                                                 third   60     1/23     <0.001  +22 (+36.7pp)    [+22.4, +48.6]pp    —
                                                                 mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       all     240    5/21     0.002   +16 (+6.7pp)     [+2.5, +10.7]pp     no          YES (arm better)
                                                                 same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                                 cross   60     1/9      0.021   +8 (+13.3pp)     [+2.9, +22.9]pp     —
                                                                 third   60     2/6      0.289   +4 (+6.7pp)      [-2.9, +15.8]pp     —
                                                                 mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
  reranker Qwen3-Reranker-0.6B-Q6_K · partition                  all     240    0/82     <0.001  +82 (+34.2pp)    [+27.9, +39.9]pp    no          YES (arm better)
                                                                 same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                 cross   60     0/43     <0.001  +43 (+71.7pp)    [+57.5, +81.3]pp    —
                                                                 third   60     0/26     <0.001  +26 (+43.3pp)    [+29.3, +54.6]pp    —
                                                                 mixed   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —
  reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       all     240    6/18     0.023   +12 (+5.0pp)     [+1.0, +9.0]pp      no          YES (arm better)
                                                                 same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                                 cross   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
                                                                 third   60     3/8      0.227   +5 (+8.3pp)      [-2.7, +18.8]pp     —
                                                                 mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
```

### Paired — the candidates against the controls and each other

This is an excerpt of the bench's every-reranker block; the full block is in the run's output. `b` = right-hand arm hit
& left-hand arm miss, `c` = the reverse (`rr:` = partition, `rrf:` = fuse).

```
  top-1:
  arm                                                                                          set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  rr:LAMAR-600m.Q5_K_M vs rr:bge-reranker-v2-m3-Q5_K_M                                         all     240    7/3      0.344   -4 (-1.7pp)      [-4.3, +1.0]pp      no          no
                                                                                               same    60     2/1      1.000   -1 (-1.7pp)      [-7.9, +4.7]pp      —
                                                                                               cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —
                                                                                               third   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
                                                                                               mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
  rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M                  all     240    4/13     0.049   +9 (+3.8pp)      [+0.3, +7.1]pp      no          YES (arm better)
                                                                                               same    60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
                                                                                               cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                                                               third   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
                                                                                               mixed   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:bge-reranker-v2-m3-Q5_K_M                                  all     240    4/6      0.754   +2 (+0.8pp)      [-1.9, +3.5]pp      no          no
                                                                                               same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                                                               cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                                                               third   60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                                                               mixed   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
  rrf:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rrf:bge-reranker-v2-m3-Q5_K_M                all     240    5/10     0.302   +5 (+2.1pp)      [-1.2, +5.3]pp      no          no
                                                                                               same    60     3/3      1.000   +0 (+0.0pp)      [-8.4, +8.4]pp      —
                                                                                               cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                                                               third   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                                               mixed   60     1/4      0.375   +3 (+5.0pp)      [-2.8, +12.5]pp     —
  rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:LAMAR-600m.Q5_K_M                          all     240    3/16     0.004   +13 (+5.4pp)     [+1.8, +8.9]pp      no          YES (arm better)
                                                                                               same    60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
                                                                                               cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                                                               third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                                                               mixed   60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:LAMAR-600m.Q5_K_M                                          all     240    2/8      0.109   +6 (+2.5pp)      [-0.2, +5.1]pp      no          no
                                                                                               same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                                                               cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                                                               third   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                                               mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  rrf:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0  all     240    7/0      0.016   -7 (-2.9pp)      [-5.2, -0.6]pp      no          YES (arm worse)
                                                                                               same    60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —
                                                                                               cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —
                                                                                               third   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                                                               mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0                   all     240    12/5     0.143   -7 (-2.9pp)      [-6.3, +0.5]pp      no          no
                                                                                               same    60     5/2      0.453   -3 (-5.0pp)      [-13.7, +4.0]pp     —
                                                                                               cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                                                               third   60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
                                                                                               mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  found@8:
  arm                                                                                          set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  rr:LAMAR-600m.Q5_K_M vs rr:bge-reranker-v2-m3-Q5_K_M                                         all     240    0/4      0.125   +4 (+1.7pp)      [-0.1, +3.5]pp      no          no
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                                                               third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                                                               mixed   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
  rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M                  all     240    7/2      0.180   -5 (-2.1pp)      [-4.6, +0.5]pp      no          no
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
                                                                                               third   60     4/1      0.375   -3 (-5.0pp)      [-12.5, +2.8]pp     —
                                                                                               mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:bge-reranker-v2-m3-Q5_K_M                                  all     240    1/4      0.375   +3 (+1.3pp)      [-0.7, +3.2]pp      no          no
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                                                               third   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                                                               mixed   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
  rrf:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rrf:bge-reranker-v2-m3-Q5_K_M                all     240    6/9      0.607   +3 (+1.3pp)      [-2.0, +4.5]pp      no          no
                                                                                               same    60     2/1      1.000   -1 (-1.7pp)      [-7.9, +4.7]pp      —
                                                                                               cross   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
                                                                                               third   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
                                                                                               mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:LAMAR-600m.Q5_K_M                          all     240    9/0      0.004   -9 (-3.8pp)      [-6.2, -1.2]pp      no          YES (arm worse)
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
                                                                                               third   60     5/0      0.063   -5 (-8.3pp)      [-15.5, -0.6]pp     —
                                                                                               mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:LAMAR-600m.Q5_K_M                                          all     240    2/1      1.000   -1 (-0.4pp)      [-2.0, +1.2]pp      YES         no
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                                                               third   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                                                               mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
  rrf:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 vs rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0  all     240    58/0     <0.001  -58 (-24.2pp)    [-29.4, -18.5]pp    no          YES (arm worse)
                                                                                               same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
                                                                                               cross   60     32/0     <0.001  -32 (-53.3pp)    [-64.4, -38.8]pp    —
                                                                                               third   60     18/0     <0.001  -18 (-30.0pp)    [-40.8, -17.3]pp    —
                                                                                               mixed   60     5/0      0.063   -5 (-8.3pp)      [-15.5, -0.6]pp     —
  rr:Qwen3-Reranker-0.6B-Q6_K vs rr:mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0                   all     240    1/9      0.021   +8 (+3.3pp)      [+0.7, +6.0]pp      no          YES (arm better)
                                                                                               same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                                                               cross   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                                                               third   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
                                                                                               mixed   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
```

### Paired across runs vs Run 2's BGE (context, not the decision)

Re-analysis only; no model was called. Digest, order seed, fact count and fixture hash all match, so the bench accepted
the pairing. `b` = Run 2 `rr:bge` hit & arm miss.

```
  top-1:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)                     all     240    14/3     0.013   -11 (-4.6pp)     [-7.9, -1.2]pp      no          YES (arm worse)
  reranker bge-reranker-v2-m3-Q5_K_M · partition                 all     240    1/1      1.000   +0 (+0.0pp)      [-1.4, +1.4]pp      YES         no
  reranker LAMAR-600m.Q5_K_M · partition                         all     240    6/2      0.289   -4 (-1.7pp)      [-4.1, +0.8]pp      no          no
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  all     240    4/13     0.049   +9 (+3.8pp)      [+0.3, +7.1]pp      no          YES (arm better)
  reranker Qwen3-Reranker-0.6B-Q6_K · partition                  all     240    4/6      0.754   +2 (+0.8pp)      [-1.9, +3.5]pp      no          no
  found@8:
  arm                                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)                     all     240    79/1     <0.001  -78 (-32.5pp)    [-38.3, -26.2]pp    no          YES (arm worse)
  reranker bge-reranker-v2-m3-Q5_K_M · partition                 all     240    0/1      1.000   +1 (+0.4pp)      [-0.7, +1.6]pp      YES         no
  reranker LAMAR-600m.Q5_K_M · partition                         all     240    0/5      0.063   +5 (+2.1pp)      [+0.1, +4.0]pp      no          no
  reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  all     240    7/3      0.344   -4 (-1.7pp)      [-4.3, +1.0]pp      no          no
  reranker Qwen3-Reranker-0.6B-Q6_K · partition                  all     240    1/5      0.219   +4 (+1.7pp)      [-0.5, +3.8]pp      no          no
```

### A/A sanity check

```
A/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so its p on `all`
must stay ≥ 0.05; if it does not, the paired test is seeing something that is not there and the run is suspect.

formula vs formula2 (engine — no model in the loop):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   +0 / +0 / +0.000           ·   p 1.000, 1.000
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     +0 / +0 / +0.000           ·   p 1.000, 1.000

judge A/A: NOT run (add content,content2) — nothing shows how far the judge wanders between identical runs.

formula positions digest: f661eb6a056e (240 queries, 60 facts, order seed 12345) — equal digests across runs mean identical formula rows, the precondition for comparing runs
```

### Latency

```
latency (ms) — parallel: mean over the accuracy pass, 10 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                            ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)                     368            237                 0/0                       0/0                    off · claude-cli · haiku
公式 · no verification · A/A twin                              368            232                 0/0                       0/0                    off · claude-cli · haiku
reranker bge-reranker-v2-m3-Q5_K_M · partition                 1191           447                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · fuse                      1194           460                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker LAMAR-600m.Q5_K_M · partition                         1198           498                 0/0                       0/0                    on · llama-cpp · LAMAR-600m.Q5_K_M
reranker LAMAR-600m.Q5_K_M · fuse                              1195           423                 0/0                       0/0                    on · llama-cpp · LAMAR-600m.Q5_K_M
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · partition  623            313                 0/0                       0/0                    on · llama-cpp · mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0
reranker mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0 · fuse       616            292                 0/0                       0/0                    on · llama-cpp · mmarco-mMiniLMv2-L12-H384-v1-rerank-Q8_0
reranker Qwen3-Reranker-0.6B-Q6_K · partition                  2568           1530                0/0                       0/0                    on · llama-cpp · Qwen3-Reranker-0.6B-Q6_K
reranker Qwen3-Reranker-0.6B-Q6_K · fuse                       2571           1104                0/0                       0/0                    on · llama-cpp · Qwen3-Reranker-0.6B-Q6_K
```

### Warnings

None. The bench printed no WARNING line. No reranker arm left a graph recall without a verdict: `judged` equals
`graph` in every set of every arm, both partition and fuse. No query errored, and no claude-cli call was made at any
time.

### By fact language — the household's case

This is not the bench's own output: it is computed from this run's saved rows, by the fact's language as
`recall-questions.mjs` decides it (40 Chinese, 16 English, 4 Japanese facts). Each cell is top-1 / found@8 / n, for
partition arms. The same script reproduces Run 2's table exactly from Run 2's file.

```
set·facts     formula       rr:BGE        rr:LAMAR      rr:mMiniLM    rr:Qwen3
same·zh       31/36/40      29/37/40      30/37/40      30/37/40      29/37/40
same·en       7/14/16       10/16/16      8/16/16       12/16/16      10/16/16
same·ja       4/4/4         4/4/4         4/4/4         4/4/4         4/4/4
cross·zh      0/0/40        0/30/40       0/30/40       1/27/40       0/30/40
cross·en      1/5/16        2/14/16       1/15/16       1/15/16       1/15/16
cross·ja      0/1/4         1/4/4         0/4/4         1/4/4         1/4/4
third·zh      1/13/40       5/28/40       5/30/40       8/27/40       7/29/40
third·en      0/4/16        2/12/16       0/12/16       3/11/16       1/12/16
third·ja      0/1/4         1/3/4         0/3/4         1/2/4         0/3/4
mixed·zh      21/31/40      23/38/40      23/39/40      22/38/40      24/39/40
mixed·en      14/16/16      13/16/16      14/16/16      15/16/16      14/16/16
mixed·ja      0/0/4         0/2/4         1/2/4         1/2/4         1/2/4
```

mMiniLM against BGE, paired (mMiniLM-only hits / BGE-only hits):

- **The household's case** (Chinese facts asked in Chinese or code-switched, `same` × zh + `mixed` × zh, 80
  queries): top-1 3/3, found@8 **0/0**. On found@8 the two are identical, query for query.
- **All 240**: top-1 13/4, found@8 2/7. mMiniLM's found@8 shortfall sits entirely in `cross` (BGE-only 3,
  mMiniLM-only 1) and `third` (4 and 1), and mostly on Chinese facts asked in another language: `cross` × zh 27
  vs 30, `third` × zh 27 vs 28.

### The decision rule, applied

- **mMiniLM (`mmarco-mMiniLMv2-L12-H384-v1` Q8_0, 132,584,000 B): VIABLE for the owner to consider.** The result
  against BGE is **no significant difference**.
  1. **Screened correctly.** It loads, (i) is ahead by 11.817970, and (ii) is ordered.
  2. **No failed call.** It judged 234/234 graph recalls in both arms, the router log holds no error, and no
     abstention occurred.
  3. **Not significantly worse than BGE on found@8.** 7/2, p = 0.180, net −5 = −2.1pp. It is not equivalent either:
     the 95% interval [−4.6, +0.5]pp reaches past −3pp, so **this run cannot rule out a found@8 loss of up to
     ~4.6pp (~11 of 240)** against BGE.

  **It keeps Run 2's gain**: its found@8 over 公式 is a finding, 1/75, p < 0.001, **+30.8pp**, [+24.6, +36.6]pp. It
  was read at its fitted input, which on this fixture is its shipped-cap arm (see the design).
- **Qwen3-Reranker-0.6B Q6_K (494,879,136 B, reference): viable by the rule.** The result against BGE is **no
  significant difference** on found@8: 1/4, p = 0.375, +1.3pp, [−0.7, +3.2]pp, whose upper bound is just past +3.
  Its found@8 is **equivalent** to LAMAR's (2/1, p = 1.000, [−2.0, +1.2]pp). It is larger than both controls and 3.4×
  slower than BGE (1,530 ms serial), so it answers nothing about smaller models.
- **xVITA-Rerank-300M-zhTW Q8_0 (332,894,432 B): not viable.** It failed screen (i) and did not run.

### What it says

- **A reranker a quarter the size keeps nearly all of the gain.** mMiniLM is 28.3% of BGE's bytes (3.53× smaller).
  Its found@8 is 199 against BGE's 204, a gap the run cannot call a loss and cannot rule one out up to ~4.6pp, and
  +74 against 公式. On the household's case its found@8 is identical to BGE's.
- **But against LAMAR, its found@8 loss IS a finding.** 9/0, p = 0.004, net −9 = **−3.8pp**, [−6.2, −1.2]pp,
  with no set against it: `third` 5/0 (p = 0.063), `cross` 3/0, `mixed` 1/0, `same` 0/0. The rule was set against
  BGE, the current `RecommendedReranker`, so this does not change the outcome. But a household on LAMAR that moves to
  mMiniLM gives up about 4 in 100 answers on the page: eight of these nine were asked in another language, one
  code-switched.
- **top-1 moves the other way, and that is the partition's arithmetic.** mMiniLM's partition arm has the best top-1
  of any arm measured on this seed other than the Claude judge's partition arms (120–132, Run 1): 99 against
  公式's 79 (3/23, p < 0.001, **+8.3pp**), and against BGE 4/13, p = 0.049, +3.8pp, and LAMAR 3/16, p = 0.004,
  +5.4pp.
  - The gain sits in `third` (0/11 against 公式) and among English facts (`same` × en 12 vs BGE's 10, `mixed` × en
    15 vs 13).
  - Under partition, top-1 is the engine's first choice among the eight a reranker endorses. A reranker that leaves a
    wrong engine favourite out of its eight lets the answer rise, whatever it scored. How often that happens differs
    by model, which is a reading of the mechanism, not a measurement.
  - The top-1 comparison against BGE is outside the rule and sits at p = 0.049, among more than 70 paired
    comparisons in this run, so it is not to be leaned on.
- **Latency.** Serial medians over 12 queries, models warm:
  - 公式 237 ms;
  - mMiniLM **313 ms**, about +0.08 s per recall;
  - BGE 447 ms, about +0.21 s, and LAMAR 498 ms, about +0.26 s; both were 474–489 ms in Run 2;
  - Qwen3 1,530 ms, about +1.29 s. It is a 0.6B decoder with a ~75-token template around every pair.

  The parallel means (mMiniLM 623 ms, BGE 1,191, LAMAR 1,198, Qwen3 2,568) were contended: ten arms at once, four
  models on one router and one GPU.
- **The controls reproduced Run 2.** BGE is 90 / 204 against Run 2's 90 / 203, and paired across runs it is
  **equivalent** on both metrics: top-1 1/1, [−1.4, +1.4]pp; found@8 0/1, [−0.7, +1.6]pp. LAMAR's totals are
  identical to Run 2's (86 / 208). LAMAR against BGE leans as it did in Run 2: found@8 LAMAR's way (0/4, p = 0.125),
  top-1 BGE's way (7/3, p = 0.344), neither a finding. So the same reranker, rerun on the same seed, moved by at most 2
  discordant queries per metric, against the 9 separating mMiniLM from LAMAR on found@8.
- **Fuse behaves as in Run 2 for every model.** It gives back most of the found@8 gain: mMiniLM fuse against its
  partition is 58/0 (−24.2pp). Its top-1 gain over 公式 survives for mMiniLM (+13, p = 0.011) and for no other model.

### What a product integration of mMiniLM would need (for the owner; nothing here was changed)

1. **A catalogue row, which also fixes its kind.** Its upstream filename has no "rerank", so as a dropped-in file the
   app would type it CHAT (`ResourceProvisioner.GgufKind`); a `GgufCatalog` row with `Capability = Reranking` makes
   that exact. The row would carry:
   - the pin: `keisuke-miyako/mmarco-mMiniLMv2-L12-H384-v1-gguf-q8_0` @ `2b37d162c88e0aeb8a1b4acb2d50f0e5ade16fd5`,
     `mmarco-mMiniLMv2-L12-H384-v1-Q8_0.gguf`, sha256 `91d70301828ba735c22eda56adb649f48975f371337e8c8b046326b885e26eed`,
     132,584,000 B;
   - a note quoting Run 4's figures with their configuration: base 79 / 125, no embedder, `EndorseCount` 8.
2. **A per-model input cap. This one is required.** The shipped `RerankInputCap.MaxChars` (1,000) makes this model
   refuse the WHOLE call for any recall that surfaces a long Chinese fact: 781 tokens against 512, screened. The
   verifier fails open, so that is silent.
   - **The query needs a bound too.** A pair is query + document + 4 special tokens ≤ 512, and the query is not capped
     today.
   - **A character budget is exact for this model.** Characters bound tokens on this tokenizer (≤ UTF-16 units + 1).
     So per call the budget can be computed exactly as 512 − 4 − (query length + 1) − 1 characters, from the GGUF's
     `bert.context_length` or the served `/props` `n_ctx`. The simple form is a flat 400 with the query bounded to
     about 100 characters.
   - **A router `/tokenize` round trip per candidate would buy nothing for this model family**, at up to 60 calls per
     recall here and 400 on a kind-filtered recall.
   - **The bound does NOT transfer to byte-level tokenizers.**
3. **The preset needs no change to load it.** llama.cpp serves 512-token slots and warns
   `n_ctx_seq (4096) > n_ctx_train (512)`. A per-model `ctx-size = 512` would state the limit instead of relying on
   the cap.
4. **The measurement still missing: what the cap COSTS on long facts.** This fixture has none, and a long-fact fixture
   needs a reseed, i.e. quota.
5. **Licence, for the owner to check.** The base model's card says Apache-2.0. Its training set is mMARCO, a
   translation of MS MARCO, whose own terms are non-commercial. The GGUF repo declares no licence.

### What it does NOT say

- **One fixture, one run, one machine.** 60 invented facts, one run per arm, one quantisation per model, one
  llama.cpp build (`b10549`, Vulkan) on one machine's GPU. The cross-run BGE pair is the only evidence of run-to-run
  noise for a reranker, and it is one pair of runs.
- **Nothing about long input.** Every fact is ≤ 101 characters, and 0 of 14,400 pairs came near 512 tokens. So the
  run cannot show the 512-token failure, nor what a fitted cap costs. The screen carries the first, and nothing yet
  carries the second. **The fitted-input arms the owner asked for did not run** (see the design): on this fixture they
  would have been identical-input twins.
- **"No significant difference" is not "as good".** mMiniLM against BGE on found@8 is neither worse nor equivalent,
  and a loss of up to ~4.6pp is inside the interval. Against LAMAR the loss is measured.
- **No embedder.** 语义 was off, as in Runs 1–3. Candidates came from the graph and FTS trigram alone, so no number
  here says what a reranker adds on top of an embedder.
- **Seed tags from the CLI.** Every arm recalled against subject tags the Claude CLI wrote. A household without a
  signed-in CLI has none, and that configuration was not measured.
- **The page size.** The found@8 gains are tied to `EndorseCount` = 8 = the page; no other limit was measured.
- **The candidate list.** Kind-filtered recalls, which can carry up to 400 candidates, were not exercised. That matters
  most for Qwen3's latency and for any per-candidate tokenization.
- **Qwen3's saturation.** Its scores saturate near 1.0 (its screen margin was 0.00074 in probability), so its
  endorsed eight are picked among near-ties. The run shows the outcome, not how stable that choice is.
- **Latency is warm.** It is a 12-query serial median with each model loaded. Cold loads (6–13 s on the screen for the
  four models that ran, including GPU start-up) are not in it. An unrelated llama-server process was resident on the
  machine throughout.
- **Recall only.** A reranker binding still annotates every fact WRITE on the Claude CLI; this run wrote nothing.

## Run 5 — newer small chat models as 判断 (design)

Written and committed BEFORE the run; the results section that follows names this commit. The screen below ran first.

**The question.** Run 3 measured `gemma-3-1b-it` as a local CHAT judge WORSE than no judge (top-1 −19.2pp, found@8
−5.8pp, content only). Lyntai's position is that small instruct models fail at SELECTIVE tasks: its 1B judge was inert
(`docs/memory-measurements.md` there, "A 1B judge is INERT"), and `docs/model-tasks.md` §3 prices instruct models in a
selective role as the shape to stop reaching for. The owner asked for the newer small multilingual chat models to be
measured anyway, on OUR fixture. **Is any newer, smaller multilingual chat model NOT significantly worse than having no
judge, bound to 判断 the way the product binds a chat GGUF?** Measurement only: no product code or catalogue row
changes here.

**Candidates**, each fetched here at a pinned repo commit and hashed over the downloaded bytes. Each sha256 equals the
repo's own LFS sha256; for the control and the reference it also equals the `GgufCatalog` pin. All sit flat in
`devtools/_rr-res/gguf/<id>.gguf`, the scratch folder Runs 2–4 used, and every id is the upstream file's stem.

| id in this run | role | uploader / repo @ commit | bytes | sha256 | GGUF header |
|---|---|---|---|---|---|
| `gemma-3-1b-it-Q4_K_M` | control (Run 3) | `ggml-org/gemma-3-1b-it-GGUF` @ `f9c28bcd85737ffc5aef028638d3341d49869c27` | 806,058,240 | `8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135` | `gemma3`, 26 blocks, ctx 32768, SentencePiece 262,144 |
| `Qwen3-0.6B-Q8_0` | candidate | `Qwen/Qwen3-0.6B-GGUF` @ `23749fefcc72300e3a2ad315e1317431b06b590a` | 639,446,688 | `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` | `qwen3`, 28 blocks, ctx 40960, BPE (`qwen2`) 151,936 |
| `gemma-3-270m-it-Q8_0` | candidate | `ggml-org/gemma-3-270m-it-GGUF` @ `e7647be17ae1108f2f605ed061ca0608b171afff` | 291,545,600 | `0ef57d2c838458a1952664260dcba38e5bdda37494f3af732f06e4add24068e3` | `gemma3`, 18 blocks, ctx 32768, SentencePiece 262,144 |
| `Qwen3.5-0.8B-Q8_0` | candidate | `ggml-org/Qwen3.5-0.8B-GGUF` @ `8fea620810c4afa23dd6443f999a48574c1611a3` | 833,592,096 | `37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f` | `qwen35`, 25 blocks (one, an MTP head, unused by llama.cpp), ctx 262144, BPE (`qwen35`) 248,320 |
| `bge-reranker-v2-m3-Q5_K_M` | reference (`RecommendedReranker`, Runs 2 and 4) | `gpustack/bge-reranker-v2-m3-GGUF` @ `3093af03b1a635e67b084b1d8c03c5f5e020fd05` | 468,392,352 | `1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef` | as Run 4 |

- **Qwen3-0.6B** (Qwen's own upload; model released 2025-04; Apache-2.0). Its card says "100+ languages and dialects",
  with thinking ON by default. **Why Q8_0:** the official repo ships a Q8_0 and nothing else for 0.6B, and at
  639,446,688 B it is under the ~700 MB line the plan set. A 4-bit quant would come from a third party, and it would be
  quantising the size class where quantisation costs most.
- **gemma-3-270m-it** (ggml-org's upload of Google's weights; released 2025-08; Gemma terms). The official repo ships
  only this Q8_0. **Its multilingual claim is the FAMILY's, not its own.** The Gemma 3 card's "over 140 languages"
  describes the training data of all sizes. The 270M's own benchmark tables are English only (HellaSwag, PIQA, ARC,
  WinoGrande, BIG-Bench Hard, IFEval). The 1B at least has a multilingual row (Global-MMLU-Lite 34.2); nothing
  multilingual is published for the 270M.
- **Qwen3.5-0.8B: the one optional addition** (ggml-org's upload of Qwen's weights; released 2026-02; Apache-2.0). It is
  the only one added because it is the clear successor to the first candidate: the same line, the same size class and
  ten months newer. It is multilingual on its own card ("201 languages and dialects"). Its card also says it "operates in
  non-thinking mode by default", which the screen below shows does not hold under llama-server. **Why Q8_0 at 834 MB:**
  the official repo's other quants are a Q4_0 (563,036,064 B) and a BF16. Q8_0 keeps all three candidates at one
  quantisation, so the comparison between them is not confounded by it. It is within the ~1 GB bound and 3.4% over the
  control's bytes. Q4_K_M files exist only from third parties (e.g. unsloth, 532,517,120 B).
- **Considered and not added**, so as not to pad the run:
  - `gemma-4-E2B`, the smallest Gemma 4: its official GGUFs are 3,349,516,256 B (Google's QAT q4_0) and 4,967,478,336 B
    (ggml-org Q8_0), far over ~1 GB.
  - `LFM2.5-350M` (Liquid AI's own GGUF, 2026-03, 379,217,632 B at Q8_0): newer and small, but a third family with no
    predecessor in these runs, under a non-OSI licence (`lfm1.0`).

### The screen (2026-09-24, before this design)

Each configuration ran on its own `llama-server` on its own port: llama.cpp **b10549** (commit `b2e5e9b28`, Vulkan x64),
the build the product pins and Runs 2–4 used. Each was killed by PID and its port re-checked free. The instrument is
`devtools/_lc5-screen/screen.mjs` (scratch, untracked; its JSON and server logs sit beside it). It sends exactly what
Lyntai 3.2.0's `LlmMemoryVerificationPolicy` puts on the wire through the app's `llamacpp` provider:

- the verifier's system prompt verbatim, then `Question:` plus the numbered notes;
- the body `{model, messages, stream:false}`, with no temperature, no max_tokens and no reasoning field;
- the notes are all 60 fixture facts, content alone (the shipped input), which is the most a bench recall can show;
- the reply is parsed the way the verifier's `Parse` does it.

Two requests, three calls each. **A** (the gate) asks the `same` question of `car-insurance`, whose note is ordinal 21.
**B** asks the `cross` question of `mkt-east`, whose note is ordinal 1. B turned out to be a poor probe: ordinal 1 is in
the prompt's own example `{"relevant":[1,4,7]}`, so B cannot tell a model that read the notes from one that copied the
example.

**Thinking: how it goes off, and why the bench must do it.**

- **As shipped, the product would run Qwen3 and Qwen3.5 THINKING.** The verifier asks for no reasoning
  (`TextReasoning.Suppress`), but Lyntai's OpenAI-shaped payload drops the field; only its Ollama payload maps it. That
  is true at `v3.2.0`, the version the app pins. llama-server's default `--reasoning auto` then opens a thinking block
  for any template that supports one.
  - Qwen3-0.6B's template thinks unless `enable_thinking` is false. With no key, the rendered prompt ends at a bare
    `<|im_start|>assistant\n`, and every call thought: 1,027–5,799 characters of `reasoning_content`, 237–1,446
    completion tokens, 1.3–7.5 s. The default `--reasoning-format` moved the thoughts out of `content`, so every reply
    still parsed. The cost is the latency.
  - Qwen3.5-0.8B's template thinks only if `enable_thinking` is true, yet with no key the rendered prompt ends in
    `<think>\n`. `auto` turned it on. The first call thought for 3,152 tokens (9,201 characters, 17.5 s). The second was
    still thinking when the screen's 300 s client timeout cut it; in the product, the 2-minute provider timeout would
    have failed it open.
- **`reasoning = off` in the model's preset section is the key.** Router mode passes it to the child as
  `--reasoning off`; the router log shows it in the spawn arguments. The template then renders its pre-closed block
  (`<think>\n\n</think>\n\n`). No call produced any reasoning, and replies were 10–15 completion tokens for Qwen3 and 6–21
  for Qwen3.5, at 53–353 ms once the model was loaded. This was verified both ways:
  - on a router started with a one-section preset (`n-gpu-layers = 99`, `reasoning = off`), with the no-key router as
    the control;
  - on a dedicated server with `--reasoning off`.
- **It is a no-op where there is nothing to turn off.** Gemma 3's rendered prompt is byte-identical with and without the
  key: sha256 `e6cc1ea4f6bf7d0b0f66a9e1bede2c9e6e1298163eb97e289c60f404a0d79cf3`, the same for the 1B and the 270M. So
  writing it on every chat section leaves the Run 3 control exactly as Run 3 ran it.
- **The alternatives:**
  - `--chat-template-kwargs {"enable_thinking":false}` renders the same prefix on a dedicated server. It was not tried
    as a preset key, and it is template-specific.
  - `--reasoning-budget 0` is WRONG for this. The template stays in thinking mode and the budget cuts the thinking
    short. The model then writes its reasoning into `content` as prose ("好的,我需要处理用户的问题…", "Okay, let's
    see…"; 246–1,204 tokens), and 4 of 6 replies did not parse.
- **Product follow-up (not done here; product code unchanged):** `LlamaServerRuntime.WritePresets` should write
  `reasoning = off` on every chat section. Without it, binding either Qwen to 判断 buys seconds of thinking per verdict,
  and a chat judge annotates every write through the same client. The Lyntai half of the gap is that the OpenAI-shaped
  payload ignores `TextReasoning.Suppress`. By dev-conventions' "recorded on both sides" rule, a preset workaround
  needs a Lyntai task naming it; this session is read-only on Lyntai and filed none.
- **What the bench does:** its `presetSection` now adds `reasoning = off` to every CHAT section. Run 5 therefore
  measures the two Qwens as the product WOULD launch them after that follow-up, not as it launches them today.

**Verdict screen**, with every model launched as the bench launches it: router, its preset section, and
`reasoning = off`. Gemma's no-key calls are pooled in, since the rendered prompt is identical. Six of Qwen3's twelve ran
on a dedicated server with `--reasoning off`, which renders the same 1,632-token prompt.

| model | calls | parsed | A (answer = 21) | B (answer = 1) | completion tokens | ms |
|---|---|---|---|---|---|---|
| gemma-3-1b (control) | 12 | 12 | `[4,7]` ×6 | `[4,7]` ×6 | 8–13 | 71–599 |
| gemma-3-270m | 12 | 5 | `[1,4,7]` ×2, 4 unparsed | `[1,4,7]` ×3, 3 unparsed | 34–31,073 | 195–153,940 |
| Qwen3-0.6B | 12 | 12 | answer first 6/6 (`[21]` ×4, `[21,23,24]` ×2) | `[1,4,7]` ×6 | 10–15 | 53–5,846 (first call = load) |
| Qwen3.5-0.8B | 6 | 5 | answer first 3/3, beside 4–5 others each | answer in 0 of 2; 1 unparsed | 6–21 | 114–353 |

- **Every candidate produced at least one reply the verifier accepts, so none is dropped.** "Usable" here means what
  the verifier's parser accepts, which is the product's own bar.
- **The small Gemmas answer the prompt, not the question.**
  - gemma-3-1b replied `[4,7]` on all 12 calls, whatever it was asked. That is a direct view of Run 3's loss
    mechanism: partition promotes whatever the judge endorses.
  - Every verdict gemma-3-270m managed was the prompt's own example, `[1,4,7]`. Its unparsed replies were lists of note
    texts instead of numbers, extra fields that broke the JSON, and two runaways to its full 32,768-token context
    (31,072 and 31,073 tokens; 154 s and 137 s). The product's default 2-minute provider timeout would fail such a call
    open at 120 s.
- **Qwen3 (thinking off) put the answer first on every A call, and copied the example on every B call.** With thinking
  ON it endorsed the answer on 11 of 12 calls, including every B. That hints thinking helps the verdict, at 10–30× the
  latency. It is not measured here.

**Memory, checked before the design** (`devtools/_lc5-screen/fit.mjs`: one router with the bench's exact five-section
preset and `--models-max 5`, warmed in arm order, then asked fresh prompts):

- All five load and stay resident, with no eviction and no error. The chat preset writes no `ctx-size`, so every child
  takes its model's training context: 4,096 for BGE (its preset), 32,768 for both Gemmas, 40,960 for Qwen3 and 262,144
  for Qwen3.5. By nvidia-smi, the Qwen3 child alone is ~5.1 GB, nearly all of it KV cache. This is a product property
  worth knowing, not a bench one.
- With all five resident the RTX 4080 Laptop GPU (12,282 MiB, ~3.5 GB of it held by other processes including the
  unrelated resident llama-server) had 1.3 GB free.
- Prompt processing for the two Qwens was 4–6× slower than alone: Qwen3 3,054–3,155 against 17,157 tokens/s, Qwen3.5
  1,946–2,096 against 7,915–8,273. The product holds at most `MaxResidentModels` = 2, so **their serial latencies in this run
  are pessimistic**, and the screen's single-model latencies are quoted beside them. Accuracy does not depend on it,
  unless a call reaches the 2-minute timeout.

### Arms, command and configuration

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula \
  --chat-judges=gemma-3-1b-it-Q4_K_M,Qwen3-0.6B-Q8_0,gemma-3-270m-it-Q8_0,Qwen3.5-0.8B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M \
  --resources=devtools/_rr-res --port-base=5620 --llama-port=5640 > devtools/_judge-bench-lc5.txt 2>&1
```

**Eleven arms in ONE run.** `formula`, then `rr:` and `rrf:` for BGE, then `lc:` (content alone, the shipped input) and
`lcb:` (`topic — content`) for each of the four chat models. The `rrf:` and `lcb:` arms are there because the bench adds
them automatically with `--rerankers` and `--chat-judges`, not because the question needs them.

- No Claude arm, so no quota is spent.
- The seed is Run 1's, reused and not reseeded. If the bench asks for a reseed, the run stops there.
- The ports keep off every tcp range Windows had reserved that day (5458–5557, 5768–5967), off the e2e fleet's ports and
  off the band the shifted e2e runner uses (5658–5757).
- **No smoke run.** The bench's startup checks run before any query, so a wiring failure costs no more in the full run.
  Low coverage is a candidate's result here, not a reason to stop, unlike Run 3, whose question needed the judge to
  judge.

**The bench changes for this run** (committed with this design; `node --check` passes). The first applies to the run
itself; the other two are analysis only.

- **`reasoning = off`** on every chat section of the shared router's preset (see the screen).
- **Two paired blocks**: each chat judge against each reranker under partition, and every chat judge against every
  other shown the same input. The first listed chat model, the control, is on the right of each of its pairs.
- **A latency block that counts EVERY graph recall of a chat judge, verdict or not.** The existing serial median leaves
  verdict-less recalls out, which is right for a fast fail-open. It is wrong for a runaway, which is slow AND
  verdict-less, and would vanish from the median exactly when it costs most.

The two analysis blocks print only for a run with a chat judge beside another local model. Runs 2, 3 and 4 were
re-analysed (`--report-only`) before and after the change, and the output is identical line for line apart from the
line naming the re-analysis file.

**Configuration of every judge arm**, stated because a judge's effect does not transfer without it:

- **Base:** this run's `formula` (79 / 125 in Runs 1–4), recalling over the seed's CLI-written subject tags.
- **Embedder: none** (语义 unbound), so candidates come from the graph and FTS trigram, ≤ 60 per recall.
- **Combination: partition** (the product default).
- **Chat judges** are shown content alone (`lc:`) or `topic — content` (`lcb:`). They sample at llama-server's default
  temperature, because the verifier names none, and each child serves 4 slots at its model's training context.
- **The reranker** reads through `RerankInputCap` at 1,000 characters with `EndorseCount` 8, as in Run 4.
- **A chat judge also ANNOTATES every fact write**, but a reused seed writes nothing, so this run measures recall only.

**Measured** (the bench's own tables, as in Runs 3–4):

- per set and on `all`: top-1, found@8, MRR, `judged`/`graph` (verdict coverage) and `endorsed`;
- the serial median (12 queries, verdict-carrying recalls only), the new every-graph-recall latency block, and the
  parallel mean;
- llama.cpp chat calls ok/failed per pass, and claude-cli calls per arm;
- paired McNemar exact p and the Agresti–Min 95% interval for: every arm against `formula`, `lc` against `lcb` per
  model, every chat judge against `rr:bge`, and every chat judge against every other on the same input.

### Decision rule

A candidate is **viable to offer for 判断** when its `lc:` arm (content alone, the input the product ships) is **NOT
significantly worse than `formula`** on top-1 AND on found@8.

- "Significantly worse" means: on `all`, paired within this run, the exact McNemar p < 0.05 AND c − b < 0, with
  b = `formula` hit & candidate miss. The bench's per-set veto does not rescue a candidate.
- **Verdict coverage (`judged`/`graph` on `all`) is stated beside every outcome.**

For a viable candidate, each metric against `formula` is recorded as exactly one of:

- **equivalent**: the 95% interval on `all` lies inside ±3pp;
- **no significant difference**: neither a finding nor equivalent, with the interval's lower bound quoted as the loss the
  run cannot rule out;
- **significantly better**.

**Coverage decides how a viable result reads** (dev-conventions' measuring rule 1: can the instrument express the
effect?). A recall with no verdict IS the formula's page, so an arm that abstains is partly `formula` under another name.

- Below 50% coverage on `all`, a viable result is recorded as **"viable, but mostly inert"**, and never as evidence
  that the model judges well.
- Whatever the coverage, one secondary analysis is pre-registered, outside the rule, as the Run 3 post-hoc split was
  not: top-1 and found@8 against `formula`, paired, on the recalls where the candidate gave a verdict.

**Reported beside the rule, outside it:**

- **each candidate against BGE** (`lc:<m>` against `rr:bge`, both metrics). BGE is the local judge the product
  recommends;
- **each candidate against the control** (`lc` against `lc:gemma-3-1b`, and `lcb` against `lcb`): is the newer model
  better than Run 3's?
- **the `lcb:` arms under the same rule.** If `lcb` is viable where `lc` is not, that is recorded for the owner as an
  input-design finding (the owner's standing direction: fit the input to the model), not as a decision;
- **`lc` against `lcb` per model**, Run 3's question;
- **latency**: serial median, every-graph-recall block, llama.cpp calls, and the screen's single-model figures;
- **exact bytes**.

**Multiplicity.** Three candidates × two metrics, each at 0.05 with no correction. That errs towards calling a candidate
worse, the conservative direction for a rule whose output is "viable to offer".

**Guards**, checked before any candidate is read:

- **The formula digest** must equal **`f661eb6a056e`**, as in Runs 1–4. If it does not, the within-run pairing stands,
  but no number here may be set beside another run's.
- **Every local arm's startup:** 判断 reads back `llama-cpp · <its id>`, with no startup warning and no claude-cli call.
  The bench enforces the first two and warns on the third.
- **Thinking really was off**, checked three ways:
  - the router's `presets.ini` carries `reasoning = off` in all four chat sections;
  - the router log shows `--reasoning off` in each chat child's spawn arguments;
  - for each Qwen child, the median completion length over the run's tasks in the router log is at most 50 tokens.
    With thinking on, the screen's shortest reply was 237.
- **Kind and residency.** None of the three new ids contains "rerank" or "embed", so `ResourceProvisioner.GgufKind`
  types all three as chat; the readback confirms the binding. The router log must show each of the five children
  spawned once and never unloaded.
- **No judge A/A twin runs.** As context outside the decision, the control is paired across runs with Run 3's
  `lc:gemma-3-1b-it-Q4_K_M` by re-analysis (`--baseline=devtools/_judge-bench/results-2026-09-24T015928.030Z.json:lc:gemma-3-1b-it-Q4_K_M`),
  provided the digests match. It is the same model, input and seed; the only change is a preset key shown above not to
  change the rendered prompt. That pair is therefore the nearest thing to a chat-judge A/A this data has. BGE is paired
  with Run 4's BGE the same way.

## Run 5 — newer small chat models as 判断 (2026-09-24, llama.cpp b10549; claude never called) — STOPPED EARLY

**Command**, exactly as registered:

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula \
  --chat-judges=gemma-3-1b-it-Q4_K_M,Qwen3-0.6B-Q8_0,gemma-3-270m-it-Q8_0,Qwen3.5-0.8B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M \
  --resources=devtools/_rr-res --port-base=5620 --llama-port=5640 > devtools/_judge-bench-lc5.txt 2>&1
```

The design above was committed as `d3058a1` before anything ran, and the run's app HEAD is that commit (v1.3.0).
That HEAD includes round 2's Tasks G (`70a573d`) and H (`cc8a61b`); the server binary was built from them, and the bench
builds nothing. Neither task touches a chat section of the preset. H's per-model reranker window applies only to the
catalogued mMiniLM row: BGE declares no window, so it is still launched at 4096 and capped at 1,000 characters, as in Run 4.

**Seed**: Run 1's, reused (created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`, fixture sha256
`9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555`). Order seed **12345** (240 queries, 0 same-fact
adjacencies), **11 arms in parallel**.

**The run was STOPPED by hand ~49 minutes in, during the accuracy pass** (first row 03:49:15Z, last row 04:38:16Z). It
never reached the serial latency pass, and it never saved a results file. Every table below was recovered from its row
stream with the bench's own recovery (`--report-only=<rows-*.jsonl>`), which confirmed order seed 12345 by regenerating
the query order and calls no model. The stop was not about the models' answers. The instrument had stopped measuring
judges; see "Why it stopped" below.

**Every pre-registered guard held**:

- **The formula digest** is **`f661eb6a056e`**, equal to Runs 1–4.
- **Startup.** Every local arm passed the bench's startup checks: 判断 read back `llama-cpp · <its id>`, there were no
  startup warnings, and no claude-cli call was made. **No arm called the CLI at any point.** That was recounted from each
  arm's preserved log (0 in all eleven). The recovery could not map `arm-N` folders itself, so each folder was matched
  to its arm by its `settings.json` binding and its knob announcement, which is configuration order.
- **Thinking was off**, checked three ways:
  - `presets.ini` carries `reasoning = off` in all four chat sections;
  - the router log shows `--reasoning off` in every chat child's spawn arguments;
  - the median completion length per task was 11 tokens for Qwen3-0.6B (274 tasks) and 12 for Qwen3.5-0.8B (467).
    The bound was 50.
- **Kind and residency.** Each of the five models spawned exactly once and was never unloaded or evicted.
- **Memory.** The GPU never ran out: 10,361–10,626 MiB used, 1,370–1,635 MiB free, sampled four times.

**What finished:**

| arm | accuracy rows | status |
|---|---|---|
| `formula` | 240/240 | complete |
| `rr:` / `rrf:` BGE (reference) | 240/240 each | complete |
| `lc:` / `lcb:` gemma-3-1b (control) | 240/240 each | complete |
| `lc:` / `lcb:` **Qwen3.5-0.8B** | 240/240 each | complete |
| `lc:` / `lcb:` **Qwen3-0.6B** | 150 / 142 | **INCOMPLETE — not readable under the rule** |
| `lc:` / `lcb:` **gemma-3-270m** | 115 / 159 | **INCOMPLETE — not readable under the rule** |

The two incomplete candidates are **not** given a decision-rule outcome. The rule is defined on all 240 paired queries,
and reading a series that stopped where it did would be optional stopping. Their partial numbers appear further down,
labelled as descriptive only.

### Why it stopped

1. **Small chat judges run away, and llama-server keeps generating for a request nobody is waiting for.** The verifier
   sends no `max_tokens`. Past the app's 2-minute provider timeout the call is abandoned, but the slot keeps decoding
   until the model stops on its own or the context is full.
   - gemma-3-270m's task 136 started 47 s into its child's life and was still generating nine and a half minutes later.
   - All four chat models did this. When the run was stopped, three tasks per child were still generating: Qwen3-0.6B
     at 3,076–4,820 tokens, Qwen3.5-0.8B at 3,579–4,649, gemma-3-270m at 1,205–6,700. One Qwen3 reply that did finish
     ran 3,816 tokens over 1,592 s.
2. **A child's 32,768-token context is SHARED by its four slots** (`kv_unified`). When a runaway filled it, every
   request in flight on that child failed with `Context size has been exceeded`: 16 gemma-3-270m tasks, three of them
   live requests the arms logged as failed calls.
3. **The runaways starved the GPU for every arm.** Utilisation was 94–96%. Median prompt throughput during the run was
   472–1,280 tokens/s per chat child, against 1,855–15,591 with all five resident and idle before the design, and up to
   17,157 alone. The Qwen3 child ended with three of its four slots held by abandoned runaways, decoding at ~2.4
   tokens/s. Every new Qwen3 verification then hit the timeout: the last 10 of `lc:Qwen3`'s 150 rows and 9 of the last 10
   of `lcb:`'s.
4. **A verification timeout does NOT fail open to the engine's page. The whole recall degrades to FTS.** All 48 recalls
   that took ≥ 110 s (120.0–120.2 s) came back `ranked: fts` with no verdict. Each arm's log carries exactly as many
   `fact index: recall failed; falling back to FTS` warnings as it has such rows. The stack runs
   `TaskCanceledException` → `LlmMemoryVerificationPolicy.VerifyAsync` → `GraphMemoryEngine.RecallAsync` →
   `FactIndex.RankAsync`.

Carried on, the run would have spent one to three more hours measuring the starvation of the Qwen3 and gemma-3-270m
arms, not their verdicts. So it was stopped, and the configuration was not changed mid-run. The product runs ONE judge
child, so this pile-up across models is the bench's own making. The three behaviours underneath it are the product's
(see "Product findings").

**The timeouts inside the complete arms**: 1 (`lc:gemma-1b`), 2 (`lcb:gemma-1b`), 3 (`lc:Qwen3.5`), 1 (`lcb:Qwen3.5`).
Each is counted as it happened, an FTS page, as the rule's "paired within this run" requires. A post-hoc check, not
pre-registered, drops the 44 queries that timed out in ANY chat arm:

- Qwen3.5's outcome under the rule is unchanged. `lc:` is not significantly worse on either metric (top-1 22/25,
  p = 0.771; found@8 10/24, p = 0.024, arm better).
- The control's top-1 loss holds (37/4, p < 0.001). Its found@8 loss is no longer significant (13/6, p = 0.167).

### The headline — the complete arms

`lc:` = content alone, the shipped input. Paired against `formula` on `all`; b = `formula` hit & arm miss.

| arm | coverage (judged/graph) | top-1 (of 240) | top-1 vs 公式 | found@8 (of 240) | found@8 vs 公式 |
|---|---|---|---|---|---|
| 公式 (base) | — | 79 | — | 125 | — |
| BGE, partition (reference) | 234/234 | 91 | 3/15, p = 0.008, **+5.0pp** | 204 | 0/79, p < 0.001, **+32.9pp** |
| gemma-3-1b `lc:` (control) | 183/233 (78.5%) | 36 | 47/4, p < 0.001, **−17.9pp** | 113 | 18/6, p = 0.023, **−5.0pp** |
| gemma-3-1b `lcb:` | 193/232 (83.2%) | 45 | 41/7, p < 0.001, **−14.2pp** | 116 | 12/3, p = 0.035, **−3.8pp** |
| **Qwen3.5-0.8B `lc:`** | **223/231 (96.5%)** | **85** | **28/34, p = 0.526, +2.5pp, [−3.9, +8.9]** | **138** | **16/29, p = 0.072, +5.4pp, [−0.1, +10.8]** |
| Qwen3.5-0.8B `lcb:` | 229/233 (98.3%) | 83 | 25/29, p = 0.683, +1.7pp, [−4.3, +7.7] | 127 | 16/18, p = 0.864, +0.8pp, [−4.0, +5.6] |

### Accuracy — the four sets and `all` (as printed; every arm, the incomplete ones included)

The `ms (parallel)` column is **not latency**: it was measured under the starvation described above. Rows for the two
incomplete candidates cover only the queries they reached. Their Δ is printed as rates because n differs, and like the
rest of their numbers it is descriptive only.

```
== same ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         42/60     54/60     0.769   302
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    60     60      60        43/60     57/60     0.808   1189           +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    60     60      60        42/60     55/60     0.790   1225           +0 / +1 / +0.021
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    60     47      47        23/60     52/60     0.525   3319           -19 / -2 / -0.243
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    59     47      47        21/60     46/60     0.468   5846           -21 / -8 / -0.301
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     60   0    60     59      51        35/60     51/60     0.668   5881           -7 / -3 / -0.100
local chat judge Qwen3.5-0.8B-Q8_0 · content only        60   0    60     58      56        35/60     49/60     0.650   9035           -7 / -5 / -0.118
local chat judge gemma-3-270m-it-Q8_0 · topic — content  50   0    47     42      39        26/50     40/50     0.608   20263          -18.0pp / -10.0pp / -0.160 (rates: n differs)
local chat judge gemma-3-270m-it-Q8_0 · content only     43   0    40     37      36        20/43     34/43     0.557   18385          -23.5pp / -10.9pp / -0.211 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · content only          50   0    49     49      49        35/50     46/50     0.792   11075          +0.0pp / +2.0pp / +0.023 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · topic — content       49   0    47     47      47        34/49     44/49     0.770   14003          -0.6pp / -0.2pp / +0.001 (rates: n differs)

== cross ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         1/60      6/60      0.042   382
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    60     60      60        3/60      48/60     0.221   1832           +2 / +42 / +0.179
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    60     60      60        2/60      12/60     0.069   1756           +1 / +6 / +0.027
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    58     44      44        1/60      7/60      0.051   9327           +0 / +1 / +0.009
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    60     42      42        0/60      5/60      0.017   5636           -1 / -1 / -0.025
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     60   0    59     59      51        5/60      16/60     0.145   9637           +4 / +10 / +0.103
local chat judge Qwen3.5-0.8B-Q8_0 · content only        60   0    59     57      50        13/60     26/60     0.279   12742          +12 / +20 / +0.237
local chat judge gemma-3-270m-it-Q8_0 · topic — content  33   0    32     30      30        0/33      2/33      0.015   16526          -1.7pp / -3.9pp / -0.027 (rates: n differs)
local chat judge gemma-3-270m-it-Q8_0 · content only     24   0    21     19      18        2/24      4/24      0.113   30399          +6.7pp / +6.7pp / +0.071 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · content only          30   0    27     27      27        2/30      7/30      0.133   22505          +5.0pp / +13.3pp / +0.092 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · topic — content       28   0    27     27      27        4/28      8/28      0.202   16224          +12.6pp / +18.6pp / +0.160 (rates: n differs)

== third ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    55     0       0         1/60      18/60     0.119   337
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    55     55      55        8/60      43/60     0.301   1495           +7 / +25 / +0.182
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    55     55      55        8/60      20/60     0.205   1477           +7 / +2 / +0.086
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    55     48      48        4/60      14/60     0.102   3476           +3 / -4 / -0.018
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    55     42      42        3/60      15/60     0.101   3856           +2 / -3 / -0.018
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     60   0    55     52      47        12/60     15/60     0.210   4399           +11 / -3 / +0.091
local chat judge Qwen3.5-0.8B-Q8_0 · content only        60   0    55     52      42        6/60      20/60     0.186   8515           +5 / +2 / +0.067
local chat judge gemma-3-270m-it-Q8_0 · topic — content  44   0    40     37      37        0/44      14/44     0.087   14375          -1.7pp / +1.8pp / -0.032 (rates: n differs)
local chat judge gemma-3-270m-it-Q8_0 · content only     30   0    25     25      24        0/30      10/30     0.095   22718          -1.7pp / +3.3pp / -0.024 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · content only          41   0    36     36      36        10/41     18/41     0.329   17465          +22.7pp / +13.9pp / +0.210 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · topic — content       39   0    31     30      30        5/39      11/39     0.184   25369          +11.2pp / -1.8pp / +0.064 (rates: n differs)

== mixed ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    59     0       0         35/60     47/60     0.657   360
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    59     59      59        37/60     56/60     0.720   1684           +2 / +9 / +0.063
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    59     59      59        35/60     51/60     0.681   1782           +0 / +4 / +0.024
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  60   0    59     54      54        17/60     43/60     0.383   4827           -18 / -4 / -0.274
local chat judge gemma-3-1b-it-Q4_K_M · content only     60   0    59     52      52        12/60     47/60     0.355   4945           -23 / +0 / -0.302
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     60   0    59     59      57        31/60     45/60     0.591   8427           -4 / -2 / -0.066
local chat judge Qwen3.5-0.8B-Q8_0 · content only        60   0    57     56      54        31/60     43/60     0.573   15824          -4 / -4 / -0.084
local chat judge gemma-3-270m-it-Q8_0 · topic — content  32   0    28     27      27        15/32     23/32     0.552   19931          -11.5pp / -6.5pp / -0.105 (rates: n differs)
local chat judge gemma-3-270m-it-Q8_0 · content only     18   0    15     13      12        5/18      11/18     0.421   34335          -30.6pp / -17.2pp / -0.236 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · content only          29   0    23     23      23        15/29     19/29     0.570   32879          -6.6pp / -12.8pp / -0.087 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · topic — content       26   0    22     22      22        15/26     19/26     0.647   26233          -0.6pp / -5.3pp / -0.010 (rates: n differs)

== all ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               240  0    234    0       0         79/240    125/240   0.397   346
reranker bge-reranker-v2-m3-Q5_K_M · partition           240  0    234    234     234       91/240    204/240   0.512   1550           +12 / +79 / +0.116
reranker bge-reranker-v2-m3-Q5_K_M · fuse                240  0    234    234     234       87/240    138/240   0.436   1560           +8 / +13 / +0.039
local chat judge gemma-3-1b-it-Q4_K_M · topic — content  240  0    232    193     193       45/240    116/240   0.265   5237           -34 / -9 / -0.132
local chat judge gemma-3-1b-it-Q4_K_M · content only     240  0    233    183     183       36/240    113/240   0.235   5071           -43 / -12 / -0.162
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     240  0    233    229     206       83/240    127/240   0.404   7086           +4 / +2 / +0.007
local chat judge Qwen3.5-0.8B-Q8_0 · content only        240  0    231    223     202       85/240    138/240   0.422   11529          +6 / +13 / +0.025
local chat judge gemma-3-270m-it-Q8_0 · topic — content  159  0    147    136     133       41/159    79/159    0.330   17791          -7.1pp / -2.4pp / -0.067 (rates: n differs)
local chat judge gemma-3-270m-it-Q8_0 · content only     115  0    101    94      90        27/115    59/115    0.323   24519          -9.4pp / -0.8pp / -0.074 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · content only          150  0    135    135     135       62/150    90/150    0.491   19323          +8.4pp / +7.9pp / +0.094 (rates: n differs)
local chat judge Qwen3-0.6B-Q8_0 · topic — content       142  0    127    126     126       58/142    82/142    0.474   19802          +7.9pp / +5.7pp / +0.078 (rates: n differs)
```

### Paired vs `formula` — the complete arms

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    3/15     0.008   +12 (+5.0pp)     [+1.5, +8.4]pp      no          YES (arm better)
                                                           same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                           cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                           third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                           mixed   60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                           same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                           cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                           third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                           mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
  local chat judge gemma-3-1b-it-Q4_K_M · topic — content  all     240    41/7     <0.001  -34 (-14.2pp)    [-19.4, -8.7]pp     no          YES (arm worse)
                                                           same    60     20/1     <0.001  -19 (-31.7pp)    [-43.4, -17.9]pp    —
                                                           cross   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                           third   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                           mixed   60     20/2     <0.001  -18 (-30.0pp)    [-42.4, -15.7]pp    —
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    47/4     <0.001  -43 (-17.9pp)    [-23.2, -12.4]pp    no          YES (arm worse)
                                                           same    60     22/1     <0.001  -21 (-35.0pp)    [-46.9, -20.9]pp    —
                                                           cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                           third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                           mixed   60     24/1     <0.001  -23 (-38.3pp)    [-50.3, -23.9]pp    —
  local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     all     240    25/29    0.683   +4 (+1.7pp)      [-4.3, +7.7]pp      no          no
                                                           same    60     10/3     0.092   -7 (-11.7pp)     [-22.8, +0.2]pp     —
                                                           cross   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
                                                           third   60     1/12     0.003   +11 (+18.3pp)    [+6.8, +28.7]pp     —
                                                           mixed   60     13/9     0.523   -4 (-6.7pp)      [-21.5, +8.6]pp     —
  local chat judge Qwen3.5-0.8B-Q8_0 · content only        all     240    28/34    0.526   +6 (+2.5pp)      [-3.9, +8.9]pp      no          no
                                                           same    60     13/6     0.167   -7 (-11.7pp)     [-25.1, +2.6]pp     —
                                                           cross   60     0/12     <0.001  +12 (+20.0pp)    [+9.0, +29.7]pp     —
                                                           third   60     1/6      0.125   +5 (+8.3pp)      [-0.6, +16.8]pp     —
                                                           mixed   60     14/10    0.541   -4 (-6.7pp)      [-22.2, +9.3]pp     —
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    0/79     <0.001  +79 (+32.9pp)    [+26.7, +38.6]pp    no          YES (arm better)
                                                           same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                           cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —
                                                           third   60     0/25     <0.001  +25 (+41.7pp)    [+27.7, +52.9]pp    —
                                                           mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                all     240    5/18     0.011   +13 (+5.4pp)     [+1.5, +9.3]pp      no          YES (arm better)
                                                           same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                           cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —
                                                           third   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
                                                           mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
  local chat judge gemma-3-1b-it-Q4_K_M · topic — content  all     240    12/3     0.035   -9 (-3.8pp)      [-6.9, -0.5]pp      no          YES (arm worse)
                                                           same    60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
                                                           cross   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                           third   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —
                                                           mixed   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    18/6     0.023   -12 (-5.0pp)     [-9.0, -1.0]pp      no          YES (arm worse)
                                                           same    60     9/1      0.021   -8 (-13.3pp)     [-22.9, -2.9]pp     —
                                                           cross   60     2/1      1.000   -1 (-1.7pp)      [-7.9, +4.7]pp      —
                                                           third   60     5/2      0.453   -3 (-5.0pp)      [-13.7, +4.0]pp     —
                                                           mixed   60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
  local chat judge Qwen3.5-0.8B-Q8_0 · topic — content     all     240    16/18    0.864   +2 (+0.8pp)      [-4.0, +5.6]pp      no          no
                                                           same    60     6/3      0.508   -3 (-5.0pp)      [-14.8, +5.1]pp     —
                                                           cross   60     3/13     0.021   +10 (+16.7pp)    [+3.7, +28.5]pp     —
                                                           third   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
                                                           mixed   60     4/2      0.688   -2 (-3.3pp)      [-11.6, +5.1]pp     —
  local chat judge Qwen3.5-0.8B-Q8_0 · content only        all     240    16/29    0.072   +13 (+5.4pp)     [-0.1, +10.8]pp     no          no
                                                           same    60     7/2      0.180   -5 (-8.3pp)      [-17.9, +1.7]pp     —
                                                           cross   60     1/21     <0.001  +20 (+33.3pp)    [+19.4, +45.1]pp    —
                                                           third   60     3/5      0.727   +2 (+3.3pp)      [-6.2, +12.7]pp     —
                                                           mixed   60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
```

### Paired — against BGE, against the control, and `lc` against `lcb` (the complete arms)

Each local chat judge against BGE under partition; b = BGE hit & chat-judge miss.

```
  top-1:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lcb:gemma-3-1b-it-Q4_K_M vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    54/8     <0.001  -46 (-19.2pp)    [-25.0, -13.0]pp    no          YES (arm worse)
                                                            same    60     22/2     <0.001  -20 (-33.3pp)    [-45.9, -18.6]pp    —
                                                            cross   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
                                                            third   60     7/3      0.344   -4 (-6.7pp)      [-16.8, +3.9]pp     —
                                                            mixed   60     22/2     <0.001  -20 (-33.3pp)    [-45.9, -18.6]pp    —
  lc:gemma-3-1b-it-Q4_K_M vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    60/5     <0.001  -55 (-22.9pp)    [-28.7, -16.8]pp    no          YES (arm worse)
                                                            same    60     23/1     <0.001  -22 (-36.7pp)    [-48.6, -22.4]pp    —
                                                            cross   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
                                                            third   60     7/2      0.180   -5 (-8.3pp)      [-17.9, +1.7]pp     —
                                                            mixed   60     27/2     <0.001  -25 (-41.7pp)    [-54.4, -26.2]pp    —
  lcb:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M     all     240    31/23    0.341   -8 (-3.3pp)      [-9.3, +2.7]pp      no          no
                                                            same    60     11/3     0.057   -8 (-13.3pp)     [-24.7, -1.1]pp     —
                                                            cross   60     2/4      0.688   +2 (+3.3pp)      [-5.1, +11.6]pp     —
                                                            third   60     4/8      0.388   +4 (+6.7pp)      [-4.8, +17.7]pp     —
                                                            mixed   60     14/8     0.286   -6 (-10.0pp)     [-24.6, +5.3]pp     —
  lc:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M      all     240    34/28    0.526   -6 (-2.5pp)      [-8.9, +3.9]pp      no          no
                                                            same    60     13/5     0.096   -8 (-13.3pp)     [-26.3, +0.5]pp     —
                                                            cross   60     1/11     0.006   +10 (+16.7pp)    [+5.5, +26.8]pp     —
                                                            third   60     5/3      0.727   -2 (-3.3pp)      [-12.7, +6.2]pp     —
                                                            mixed   60     15/9     0.307   -6 (-10.0pp)     [-25.3, +5.9]pp     —
  found@8:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lcb:gemma-3-1b-it-Q4_K_M vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    88/0     <0.001  -88 (-36.7pp)    [-42.5, -30.2]pp    no          YES (arm worse)
                                                            same    60     5/0      0.063   -5 (-8.3pp)      [-15.5, -0.6]pp     —
                                                            cross   60     41/0     <0.001  -41 (-68.3pp)    [-78.3, -53.9]pp    —
                                                            third   60     29/0     <0.001  -29 (-48.3pp)    [-59.6, -34.0]pp    —
                                                            mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —
  lc:gemma-3-1b-it-Q4_K_M vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    91/0     <0.001  -91 (-37.9pp)    [-43.8, -31.4]pp    no          YES (arm worse)
                                                            same    60     11/0     <0.001  -11 (-18.3pp)    [-27.8, -7.7]pp     —
                                                            cross   60     43/0     <0.001  -43 (-71.7pp)    [-81.3, -57.5]pp    —
                                                            third   60     28/0     <0.001  -28 (-46.7pp)    [-57.9, -32.4]pp    —
                                                            mixed   60     9/0      0.004   -9 (-15.0pp)     [-23.8, -5.2]pp     —
  lcb:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M     all     240    79/2     <0.001  -77 (-32.1pp)    [-38.0, -25.7]pp    no          YES (arm worse)
                                                            same    60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —
                                                            cross   60     33/1     <0.001  -32 (-53.3pp)    [-65.2, -38.0]pp    —
                                                            third   60     28/0     <0.001  -28 (-46.7pp)    [-57.9, -32.4]pp    —
                                                            mixed   60     12/1     0.003   -11 (-18.3pp)    [-28.7, -6.8]pp     —
  lc:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M      all     240    67/1     <0.001  -66 (-27.5pp)    [-33.1, -21.5]pp    no          YES (arm worse)
                                                            same    60     8/0      0.008   -8 (-13.3pp)     [-21.8, -4.0]pp     —
                                                            cross   60     23/1     <0.001  -22 (-36.7pp)    [-48.6, -22.4]pp    —
                                                            third   60     23/0     <0.001  -23 (-38.3pp)    [-49.5, -24.7]pp    —
                                                            mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —
```

Every complete chat judge against the other, same input; b = the control (gemma-3-1b) hit & Qwen3.5 miss.

```
  top-1:
  arm                                                   set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs lc:gemma-3-1b-it-Q4_K_M       all     240    12/61    <0.001  +49 (+20.4pp)    [+13.8, +26.7]pp    no          YES (arm better)
                                                        same    60     5/19     0.007   +14 (+23.3pp)    [+7.8, +37.4]pp     —
                                                        cross   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —
                                                        third   60     2/5      0.453   +3 (+5.0pp)      [-4.0, +13.7]pp     —
                                                        mixed   60     5/24     <0.001  +19 (+31.7pp)    [+15.1, +46.2]pp    —
  lcb:Qwen3.5-0.8B-Q8_0 vs lcb:gemma-3-1b-it-Q4_K_M     all     240    16/54    <0.001  +38 (+15.8pp)    [+9.2, +22.2]pp     no          YES (arm better)
                                                        same    60     7/19     0.029   +12 (+20.0pp)    [+3.7, +35.1]pp     —
                                                        cross   60     1/5      0.219   +4 (+6.7pp)      [-1.8, +14.7]pp     —
                                                        third   60     1/9      0.021   +8 (+13.3pp)     [+2.9, +22.9]pp     —
                                                        mixed   60     7/21     0.013   +14 (+23.3pp)    [+6.5, +38.6]pp     —
  found@8:
  arm                                                   set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs lc:gemma-3-1b-it-Q4_K_M       all     240    13/38    <0.001  +25 (+10.4pp)    [+4.6, +16.0]pp     no          YES (arm better)
                                                        same    60     4/7      0.549   +3 (+5.0pp)      [-6.0, +15.7]pp     —
                                                        cross   60     0/21     <0.001  +21 (+35.0pp)    [+21.7, +46.1]pp    —
                                                        third   60     2/7      0.180   +5 (+8.3pp)      [-1.7, +17.9]pp     —
                                                        mixed   60     7/3      0.344   -4 (-6.7pp)      [-16.8, +3.9]pp     —
  lcb:Qwen3.5-0.8B-Q8_0 vs lcb:gemma-3-1b-it-Q4_K_M     all     240    12/23    0.090   +11 (+4.6pp)     [-0.3, +9.4]pp      no          no
                                                        same    60     5/4      1.000   -1 (-1.7pp)      [-11.6, +8.4]pp     —
                                                        cross   60     3/12     0.035   +9 (+15.0pp)     [+2.4, +26.6]pp     —
                                                        third   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                        mixed   60     4/6      0.754   +2 (+3.3pp)      [-7.2, +13.7]pp     —
```

Content only (`lc`) against `topic — content` (`lcb`) per model, Run 3's question; b = `lcb` hit & `lc` miss.

```
  top-1:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-1b-it-Q4_K_M vs lcb:gemma-3-1b-it-Q4_K_M  all     240    25/16    0.211   -9 (-3.8pp)      [-8.9, +1.5]pp      no          no
                                                       same    60     9/7      0.804   -2 (-3.3pp)      [-16.2, +9.8]pp     —
                                                       cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                       third   60     2/1      1.000   -1 (-1.7pp)      [-7.9, +4.7]pp      —
                                                       mixed   60     13/8     0.383   -5 (-8.3pp)      [-22.8, +6.6]pp     —
  lc:Qwen3.5-0.8B-Q8_0 vs lcb:Qwen3.5-0.8B-Q8_0        all     240    33/35    0.904   +2 (+0.8pp)      [-5.9, +7.6]pp      no          no
                                                       same    60     11/11    1.000   +0 (+0.0pp)      [-15.2, +15.2]pp    —
                                                       cross   60     4/12     0.077   +8 (+13.3pp)     [+0.3, +25.5]pp     —
                                                       third   60     7/1      0.070   -6 (-10.0pp)     [-18.9, -0.5]pp     —
                                                       mixed   60     11/11    1.000   +0 (+0.0pp)      [-15.2, +15.2]pp    —
  found@8:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-1b-it-Q4_K_M vs lcb:gemma-3-1b-it-Q4_K_M  all     240    13/10    0.678   -3 (-1.3pp)      [-5.2, +2.7]pp      no          no
                                                       same    60     7/1      0.070   -6 (-10.0pp)     [-18.9, -0.5]pp     —
                                                       cross   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
                                                       third   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                       mixed   60     2/6      0.289   +4 (+6.7pp)      [-2.9, +15.8]pp     —
  lc:Qwen3.5-0.8B-Q8_0 vs lcb:Qwen3.5-0.8B-Q8_0        all     240    21/32    0.169   +11 (+4.6pp)     [-1.4, +10.5]pp     no          no
                                                       same    60     6/4      0.754   -2 (-3.3pp)      [-13.7, +7.2]pp     —
                                                       cross   60     7/17     0.064   +10 (+16.7pp)    [+0.8, +31.4]pp     —
                                                       third   60     1/6      0.125   +5 (+8.3pp)      [-0.6, +16.8]pp     —
                                                       mixed   60     7/5      0.774   -2 (-3.3pp)      [-14.6, +8.1]pp     —
```

### Across runs (context, not the decision)

Re-analysis only; no model was called. Digest, order seed, fact count and fixture all match, so the bench accepted each
pairing. `b` = the earlier run's arm hit & this run's miss.

The control against Run 3's `lc:gemma-3-1b-it-Q4_K_M`: the same model, input and seed, differing only by
`reasoning = off`, which the design showed renders a byte-identical prompt. This is the nearest thing to a chat-judge
A/A this data has.

```
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    11/14    0.690   +3 (+1.3pp)      [-2.9, +5.4]pp      no          no
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-1b-it-Q4_K_M · content only     all     240    7/9      0.804   +2 (+0.8pp)      [-2.5, +4.2]pp      no          no
```

BGE against Run 4's BGE:

```
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    1/2      1.000   +1 (+0.4pp)      [-1.2, +2.0]pp      YES         no
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
```

- **The control reproduced Run 3**: 36 / 113 against Run 3's 33 / 111. There is no significant difference on either
  metric. It is not equivalent, though: the top-1 interval reaches +5.4pp. Run to run, this sampling 1B judge moved
  **25** discordant queries on top-1 and **16** on found@8. That is the noise floor a chat-judge gap here should be
  read against. Run 1's Claude A/A differed by 2.
- **BGE reproduced Runs 2 and 4**: 91 / 204, equivalent to Run 4's on both metrics (top-1 1/2; found@8 0/0).

### Secondary, pre-registered, outside the rule — only the recalls that carried a verdict

Paired against `formula` on each arm's judged recalls (`devtools/_lc5-screen/judged-only.mjs`, scratch; it reproduces
Run 3's post-hoc split exactly from Run 3's file).

| arm | judged | top-1 b/c, p, net | found@8 b/c, p, net |
|---|---|---|---|
| gemma-3-1b `lc:` | 183 | 45/4, p < 0.001, −22.4pp | 14/6, p = 0.115, −4.4pp |
| gemma-3-1b `lcb:` | 193 | 41/7, p < 0.001, −17.6pp | 11/3, p = 0.057, −4.1pp |
| Qwen3.5-0.8B `lc:` | 223 | 27/34, p = 0.443, +3.1pp | 15/28, p = 0.066, +5.8pp, [+0.0, +11.5] |
| Qwen3.5-0.8B `lcb:` | 229 | 25/29, p = 0.683, +1.7pp | 15/18, p = 0.728, +1.3pp |
| *Qwen3-0.6B `lc:` (INCOMPLETE, descriptive)* | *135* | *4/22, p < 0.001, +13.3pp* | *2/14, p = 0.004, +8.9pp* |
| *Qwen3-0.6B `lcb:` (INCOMPLETE, descriptive)* | *126* | *5/22, p = 0.002, +13.5pp* | *2/14, p = 0.004, +9.5pp* |
| *gemma-3-270m `lc:` (INCOMPLETE, descriptive)* | *94* | *9/0, p = 0.004, −9.6pp* | *5/2, p = 0.453, −3.2pp* |
| *gemma-3-270m `lcb:` (INCOMPLETE, descriptive)* | *136* | *9/1, p = 0.021, −5.9pp* | *6/3, p = 0.508, −2.2pp* |

### INCOMPLETE — Qwen3-0.6B and gemma-3-270m (descriptive only; NOT readable under the rule)

These series stopped at 150 / 142 (Qwen3) and 115 / 159 (gemma-3-270m) of 240 queries. Their tails are dominated by
timeouts (FTS pages), and their sets are unbalanced: Qwen3 `lc:` reached 50 `same`, 30 `cross`, 41 `third` and 29
`mixed`. No outcome is recorded for either. The printed paired rows against `formula`, on the queries each reached:

```
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-270m-it-Q8_0 · topic — content  all     159    11/2     0.022   -9 (-5.7pp)      [-10.1, -1.1]pp     no          YES (arm worse)
  local chat judge gemma-3-270m-it-Q8_0 · content only     all     115    11/2     0.022   -9 (-7.8pp)      [-13.8, -1.6]pp     no          YES (arm worse)
  local chat judge Qwen3-0.6B-Q8_0 · content only          all     150    8/22     0.016   +14 (+9.3pp)     [+2.2, +16.2]pp     no          YES (arm better)
  local chat judge Qwen3-0.6B-Q8_0 · topic — content       all     142    8/22     0.016   +14 (+9.9pp)     [+2.3, +17.1]pp     no          YES (arm better)
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  local chat judge gemma-3-270m-it-Q8_0 · topic — content  all     159    11/3     0.057   -8 (-5.0pp)      [-9.6, -0.3]pp      no          no
  local chat judge gemma-3-270m-it-Q8_0 · content only     all     115    9/4      0.267   -5 (-4.3pp)      [-10.5, +1.9]pp     no          no
  local chat judge Qwen3-0.6B-Q8_0 · content only          all     150    7/15     0.134   +8 (+5.3pp)      [-0.9, +11.4]pp     no          no
  local chat judge Qwen3-0.6B-Q8_0 · topic — content       all     142    9/14     0.405   +5 (+3.5pp)      [-3.2, +10.1]pp     no          no
```

Against BGE, on the same queries:

```
  top-1:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lcb:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     159    19/2     <0.001  -17 (-10.7pp)    [-16.0, -5.1]pp     no          YES (arm worse)
                                                            same    50     8/1      0.039   -7 (-14.0pp)     [-24.8, -2.1]pp     —
                                                            cross   33     2/0      0.500   -2 (-6.1pp)      [-15.2, +3.8]pp     —
                                                            third   44     5/0      0.063   -5 (-11.4pp)     [-20.8, -0.9]pp     —
                                                            mixed   32     4/1      0.375   -3 (-9.4pp)      [-22.6, +5.0]pp     —
  lc:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     115    14/2     0.004   -12 (-10.4pp)    [-16.9, -3.6]pp     no          YES (arm worse)
                                                            same    43     9/0      0.004   -9 (-20.9pp)     [-32.5, -7.5]pp     —
                                                            cross   24     0/2      0.500   +2 (+8.3pp)      [-5.0, +20.4]pp     —
                                                            third   30     3/0      0.250   -3 (-10.0pp)     [-21.2, +2.4]pp     —
                                                            mixed   18     2/0      0.500   -2 (-11.1pp)     [-26.4, +6.4]pp     —
  lc:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M        all     150    12/18    0.362   +6 (+4.0pp)      [-3.2, +11.1]pp     no          no
                                                            same    50     4/6      0.754   +2 (+4.0pp)      [-8.6, +16.3]pp     —
                                                            cross   30     2/2      1.000   +0 (+0.0pp)      [-13.7, +13.7]pp    —
                                                            third   41     1/6      0.125   +5 (+12.2pp)     [-0.8, +24.0]pp     —
                                                            mixed   29     5/4      1.000   -1 (-3.4pp)      [-23.2, +16.7]pp    —
  lcb:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M       all     142    9/16     0.230   +7 (+4.9pp)      [-2.0, +11.8]pp     no          no
                                                            same    49     5/7      0.774   +2 (+4.1pp)      [-9.9, +17.7]pp     —
                                                            cross   28     0/3      0.250   +3 (+10.7pp)     [-2.6, +22.6]pp     —
                                                            third   39     3/3      1.000   +0 (+0.0pp)      [-12.6, +12.6]pp    —
                                                            mixed   26     1/3      0.625   +2 (+7.7pp)      [-8.3, +22.6]pp     —
  found@8:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lcb:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     159    47/0     <0.001  -47 (-29.6pp)    [-36.3, -22.1]pp    no          YES (arm worse)
                                                            same    50     7/0      0.016   -7 (-14.0pp)     [-23.5, -3.4]pp     —
                                                            cross   33     20/0     <0.001  -20 (-60.6pp)    [-74.5, -39.8]pp    —
                                                            third   44     15/0     <0.001  -15 (-34.1pp)    [-46.8, -18.4]pp    —
                                                            mixed   32     5/0      0.063   -5 (-15.6pp)     [-27.9, -1.5]pp     —
  lc:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     115    29/1     <0.001  -28 (-24.3pp)    [-32.2, -15.7]pp    no          YES (arm worse)
                                                            same    43     7/0      0.016   -7 (-16.3pp)     [-27.0, -4.1]pp     —
                                                            cross   24     11/1     0.006   -10 (-41.7pp)    [-61.3, -15.7]pp    —
                                                            third   30     8/0      0.008   -8 (-26.7pp)     [-41.2, -8.8]pp     —
                                                            mixed   18     3/0      0.250   -3 (-16.7pp)     [-33.5, +3.5]pp     —
  lc:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M        all     150    28/0     <0.001  -28 (-18.7pp)    [-24.7, -12.1]pp    no          YES (arm worse)
                                                            same    50     1/0      1.000   -1 (-2.0pp)      [-7.2, +3.4]pp      —
                                                            cross   30     13/0     <0.001  -13 (-43.3pp)    [-58.7, -22.5]pp    —
                                                            third   41     8/0      0.008   -8 (-19.5pp)     [-31.1, -6.1]pp     —
                                                            mixed   29     6/0      0.031   -6 (-20.7pp)     [-34.6, -4.1]pp     —
  lcb:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M       all     142    31/2     <0.001  -29 (-20.4pp)    [-27.4, -12.9]pp    no          YES (arm worse)
                                                            same    49     2/0      0.500   -2 (-4.1pp)      [-10.5, +2.6]pp     —
                                                            cross   28     11/1     0.006   -10 (-35.7pp)    [-53.6, -13.0]pp    —
                                                            third   39     14/0     <0.001  -14 (-35.9pp)    [-49.4, -18.9]pp    —
                                                            mixed   26     4/1      0.375   -3 (-11.5pp)     [-27.4, +6.0]pp     —
```

Read as a hint for the re-run and nothing more:

- Qwen3-0.6B's partial numbers lean the OTHER way from Run 3's Gemma. On what it reached it is ahead of `formula` on
  top-1, and on its judged recalls it is ahead on both metrics.
- gemma-3-270m's lean the same way as the 1B's: behind on top-1.

### Latency

**No clean latency pass ran.** The serial pass comes after the accuracy pass, and the run was stopped first. The
parallel means in the tables were measured under the starvation above, and they are not a latency figure for any model.
The only latency evidence for these models is the design's screen, one model per server and warm, thinking off:
Qwen3-0.6B 53–250 ms and Qwen3.5-0.8B 114–353 ms per verdict; gemma-3-270m from 195 ms up to its runaways.

### Product findings (for the owner; nothing here was changed)

1. **llama-server does not cancel an abandoned request.** On b10549 a non-streaming chat request whose client has gone
   away keeps its slot decoding until the model stops or the context is full. The app's 2-minute provider timeout
   therefore bounds how long a recall WAITS, not how long the GPU is busy. A judge that runs away holds a slot and GPU
   time long after the recall has moved on.
2. **The chat preset has no generation cap.** `WritePresets` writes nothing but `n-gpu-layers` for a chat model, and the
   verifier sends no `max_tokens`. So one runaway can grow until it fills the child's context, which its four slots
   share. When it does, it fails every request in flight on that child. A verdict is a short JSON array, and the
   design's screen measured 6–21 tokens for the Qwens with thinking off.
3. **A verification timeout degrades the whole recall to FTS, instead of failing open to the engine's page.** The
   verifier's contract is that a failed judgement leaves the ranking alone. Here the cancellation propagated out of
   `VerifyAsync`, the graph recall failed, and `FactIndex` fell back to its FTS page: 48 of 48 timed-out recalls,
   `ranked: fts`, no verdict. So a slow judge costs the household the graph's ranking too, and that is exactly when it
   is slowest.

The design's own follow-up still stands: write `reasoning = off` into every chat section.

### The decision rule, applied

- **Qwen3.5-0.8B (833,592,096 B): VIABLE to offer for 判断.** Its `lc:` arm is not significantly worse than `formula` on
  either metric, and coverage is **96.5%** (223/231), so it is not "mostly inert".
  - top-1: **no significant difference** (28/34, p = 0.526, +2.5pp). The run cannot rule out a loss of up to 3.9pp.
  - found@8: **no significant difference** (16/29, p = 0.072, +5.4pp). The interval [−0.1, +10.8]pp only just reaches
    below zero.
  - `lcb:` passes the rule too (top-1 p = 0.683, found@8 p = 0.864).
  - This run's caveat: 3 of its 240 recalls timed out and are counted as FTS pages. With them and every other
    timed-out query excluded, the outcome is unchanged (see above).
- **Against BGE, the reference: significantly worse on found@8.** 67/1, p < 0.001, **−27.5pp**. top-1 shows no
  significant difference (34/28, p = 0.526).
- **Against the Run 3 control: significantly better on both metrics.** top-1 12/61, **+20.4pp**; found@8 13/38,
  **+10.4pp**; both p < 0.001.
- **gemma-3-1b (the control) would not be viable.** It is significantly worse than `formula` on both metrics, as in Run 3.
- **Qwen3-0.6B (639,446,688 B) and gemma-3-270m-it (291,545,600 B): NO OUTCOME.** Their series are incomplete (see
  above). The re-run is a separate task.

### What it says

- **A newer small chat model does not have to repeat Run 3's harm.** On the same seed and questions, Qwen3.5-0.8B
  judges like a model reading the notes: no significant cost against no judge, and a large, significant lead over Gemma
  1B.
  - It is SELECTIVE. It endorsed nothing on 21 of its 223 verdicts (`endorsed` 202), where the 1B endorsed something on
    every verdict it gave.
  - Its effect is uneven across the sets. `cross` gains a lot: top-1 0/12, +20.0pp; found@8 1/21, +33.3pp; both
    p < 0.001. `same` and `mixed`, where 公式 already puts the answer first most of the time, lean the other way:
    top-1 13/6 and 14/10, neither significant on its own. A per-set pattern read after the fact is not a finding. It
    matters to a household whose facts are Chinese and asked in Chinese or code-switched, which lives mostly in `same`
    and `mixed`.
- **It is no substitute for the reranker.** BGE puts the answer on the page on 204 of 240 queries; Qwen3.5 does on 138.
  BGE got there as a reranker under partition, which changes what reaches the page, and costs ~0.45 s warm (Runs 2 and 4).
- **Beside the other judges on this seed** (digest `f661eb6a056e`; quoted from the tables, not paired here), top-1 /
  found@8 of 240:

  | judge | top-1 / found@8 |
  |---|---|
  | 公式 | 79 / 125 |
  | Claude judge (Run 1 `content`) | 132 / 133 |
  | BGE (this run) | 91 / 204 |
  | Qwen3.5-0.8B `lc:` | 85 / 138 |
  | gemma-3-1b `lc:` | 36 / 113 |

  Qwen3.5 is the first LOCAL chat judge measured here that does not lose to having none.
- **The runaway is the practical risk, and it is every chat model's.** All four ran away in this run. In a household's
  one-judge install that does not starve other models, but it does hold the GPU (finding 1). It fills the child's
  shared context (finding 2). And a recall that meets the timeout loses its graph ranking (finding 3).

### What it does NOT say

- **Nothing about Qwen3-0.6B or gemma-3-270m** under the rule. Their partial rows are not a result.
- **Nothing about latency.** No serial pass ran.
- **Thinking was off by a preset key the product does not yet write.** As shipped, both Qwens would think (see the
  design).
- **One fixture, one run, one machine**, with five models resident under the bench's `--models-max 5`. The product holds
  at most two, and one judge child.
- **Sampling noise is large for a chat judge.** The control moved 25 discordant top-1 queries between two identical
  configurations. No A/A twin of Qwen3.5 ran.
- **Recall only.** A chat judge also annotates every fact write. Every arm here recalled over subject tags the Claude
  CLI wrote when the seed was made, and a household on a local chat judge would have tags that model wrote.
- **No embedder.** 语义 was off, as in Runs 1–4. Candidates came from the graph and FTS trigram alone.
- **The timeouts inside the complete arms** (1–3 each) are counted as the product would have served them: FTS pages.

**Evidence, local only.** `devtools/_lc5-evidence/` is gitignored, so it exists only on the machine that ran this. It
holds the router log, `presets.ini`, the row stream, the bench's own output, the recovered re-analysis, both cross-run
re-analyses, the post-hoc fallback check, and every arm's logs and `settings.json`. The screen and analysis scripts
sit in `devtools/_lc5-screen/`, also untracked.

## Run 5b — the three candidates, one chat model per run, as the product now launches them (design)

An amendment to Run 5, written and committed BEFORE any of its runs; the results section that follows names this
commit.

**Why an amendment.** Run 5 stopped with two of its three candidates incomplete. Several chat children shared one GPU,
runaway replies were uncapped, llama-server kept decoding abandoned requests, and every 2-minute timeout degraded its
recall to FTS. Round 2's Task P then changed the product in three commits (`bbc9b10`, `d644e86`, `28ea1d4`):

- a chat section of the generated preset carries `reasoning = off` and `n-predict = 512`
  (`LlamaServerRuntime.ChatMaxTokens`); rerankers and embedders get neither;
- verification has its own deadline, 60 s by default (`VerificationDeadlinePolicy`, half the tool call's 120 s). A hung
  judge now yields NoOpinion and the engine's own page stands, where it used to fall back to FTS;
- reranker input under a DECLARED window is NFKC-normalised. BGE's row declares no window, so BGE is unaffected.

**The question**, unchanged from Run 5: is any newer, smaller multilingual chat model NOT significantly worse than
having no judge, bound to 判断 the way the product binds a chat GGUF, now as the product launches it (thinking off,
capped, with the deadline)?

**The design: one chat model per run, three runs, one after another.** With one chat child, a runaway can no longer
starve another arm's judge. The router holds exactly two models, the chat model and BGE, which is also the most the
product ever holds (`MaxResidentModels` = 2). Qwen3.5-0.8B, complete in Run 5, is measured again so that all three
candidates are read in one configuration. The gemma-3-1b control is not re-run. Each run's within-run reference is BGE,
and the control's Run 3 and Run 5 figures are context only.

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=Qwen3-0.6B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5600 --llama-port=5610 \
  > devtools/_judge-bench-lc5b-qwen3.txt 2>&1
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=gemma-3-270m-it-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5620 --llama-port=5630 \
  > devtools/_judge-bench-lc5b-gemma270m.txt 2>&1
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=Qwen3.5-0.8B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5640 --llama-port=5650 \
  > devtools/_judge-bench-lc5b-qwen35.txt 2>&1
```

They run in that order, driven by a scratch script (`devtools/_lc5b/`). After each run, the script copies that run's
router log, `presets.ini` and arm logs aside, since the next run overwrites them, and checks the guards below.

- **The ports** sit in 5600–5656, off every tcp range Windows had reserved that day (5458–5557, 5768–5967), off the
  e2e fleet's ports and off the shifted runner's band (5658–5757).
- **Five arms per run**: `formula`, `rr:bge-reranker-v2-m3-Q5_K_M` (the reference), `rrf:` BGE, `lc:<model>` and
  `lcb:<model>`. `rrf:` and `lcb:` are there because the bench adds them automatically with `--rerankers` and
  `--chat-judges`.
- **No Claude arm, and the seed is reused**, as in Run 5. If the bench asks for a reseed, the sequence stops.
- **The bench**, as committed in `0b588af`:
  - it writes the chat section exactly as the product now does (`n-gpu-layers = 99`, `reasoning = off`,
    `n-predict = 512`);
  - it pins the deadline test knob (`GATHERLIGHT_JUDGE_DEADLINE_SECONDS`) blank, and startup refuses an arm that
    announces it, so every arm runs the product's 60 s deadline;
  - Runs 2–5 re-analyse identically under it, apart from the line naming the re-analysis file.

**Configuration of every judge arm**, as in Run 5 except where marked:

- **Base:** each run's own `formula`, recalling over the seed's CLI-written subject tags.
- **Embedder: none**, so candidates come from the graph and FTS trigram, ≤ 60 per recall.
- **Combination: partition.**
- **Chat judge:**
  - shown content alone (`lc:`) or `topic — content` (`lcb:`);
  - sampled at llama-server's default temperature;
  - its child serves 4 slots at the model's training context;
  - **new:** thinking off and at most 512 generated tokens per request, from the preset;
  - **new:** a 60 s verification deadline.
- **Reranker:** `RerankInputCap` at 1,000 characters, `EndorseCount` 8, as in Runs 4–5.

**The serial latency pass is part of every run.** The bench runs it on its own after the accuracy pass: one arm at a
time over the first 12 queries in the shared order (`--latency-sample`, default 12). A judge arm's serial median counts
only recalls that carried a verdict, and the every-graph-recall block counts all of them. It never ran in Run 5, which
was stopped first. **A run counts as complete only when every arm has 240 accuracy rows AND 12 latency rows.**

**Measured**, as in Run 5:

- per set and on `all`: top-1, found@8, MRR, `judged`/`graph` and `endorsed`;
- the serial median, the every-graph-recall latency block, and llama.cpp and claude-cli calls per pass;
- paired McNemar exact p and the Agresti–Min 95% interval for every arm against `formula`, `lc` against `lcb`, and each
  chat judge against `rr:` BGE.

### Decision rule (unchanged from Run 5)

A candidate is **viable to offer for 判断** when its `lc:` arm is **NOT significantly worse than `formula`** on top-1 AND
on found@8.

- "Significantly worse" means: on `all`, paired within the candidate's own run, the exact McNemar p < 0.05 AND
  c − b < 0, with b = `formula` hit & candidate miss. The per-set veto does not rescue a candidate.
- **Coverage** (`judged`/`graph` on `all`) is stated beside every outcome. Below 50%, a viable result is recorded as
  "viable, but mostly inert".

For a viable candidate, each metric is recorded as exactly one of: **equivalent** (the 95% interval inside ±3pp), **no
significant difference** (quoting the interval's lower bound as the loss the run cannot rule out), or **significantly
better**.

**Reported beside the rule, outside it:**

- each candidate against BGE in its own run, both metrics;
- the `lcb:` arm under the same rule, recorded as an input-design finding if it passes where `lc:` does not;
- `lc` against `lcb`;
- the clean serial latency;
- the judged-only secondary analysis, pre-registered exactly as in Run 5;
- exact bytes, as in Run 5's design.

**Multiplicity:** three candidates × two metrics, each at 0.05 with no correction, the conservative direction.

**A candidate whose run did not complete gets no outcome.** A partial series is not re-read, as in Run 5.

**Guards**, checked after each run by `devtools/_lc5b/guards5b.mjs` (scratch). That checker was confirmed to FAIL on
Run 5's evidence: no `--n-predict` in the chat spawns, 21 chat tasks over 512 tokens, and 11 FTS fallbacks in
`lc:Qwen3`. **A failed guard stops the sequence after that run, and it is reported, not worked around.**

1. **The formula digest** is **`f661eb6a056e`** in every run.
2. **Startup.** The bench's own checks pass: 判断 reads back `llama-cpp · <id>`, with no startup warning, no
   claude-cli call and no knob leak, and the deadline knob is not announced.
3. **The chat child's spawn arguments** carry `--reasoning off` and `--n-predict 512`. Each of the two models spawns
   exactly once, and none is unloaded, evicted or out of memory.
4. **The cap held:** no chat task generated more than 512 tokens. A task that generated exactly 512 is a runaway that
   was capped (`finish_reason: length`). It is counted and reported, and it is not a failure.
5. **No FTS fallback.** No arm's log may carry `fact index: recall failed; falling back to FTS`. With the deadline, a
   hung judge is NoOpinion (`memory verification gave no verdict within 60 s`); those lines are counted and reported,
   and they are not a failure. An FTS line means the deadline did not hold. It is a finding, and it fails the guard.
6. **No claude-cli call** by any arm over the whole run.

**Readings across runs are descriptive only** (measuring rule 2). Each run starts from the same seed, but a run's
recalls reinforce what they return, so only the within-run pairing is evidence. That covers each candidate against the
other two, Run 5b against Run 5, and each candidate against Run 3's or Run 5's control. The three `formula` arms must
agree by digest. The three BGE arms are reported side by side as an instrument check: the same reranker, rerun on the
same seed.

## Run 5b — one chat model per run, as the product now launches them (2026-09-24, llama.cpp b10549; claude never called)

**Commands**, exactly as registered, run in order by the scratch driver `devtools/_lc5b/run-all.sh`:

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=Qwen3-0.6B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5600 --llama-port=5610 \
  > devtools/_judge-bench-lc5b-qwen3.txt 2>&1
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=gemma-3-270m-it-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5620 --llama-port=5630 \
  > devtools/_judge-bench-lc5b-gemma270m.txt 2>&1
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula --chat-judges=Qwen3.5-0.8B-Q8_0 \
  --rerankers=bge-reranker-v2-m3-Q5_K_M --resources=devtools/_rr-res --port-base=5640 --llama-port=5650 \
  > devtools/_judge-bench-lc5b-qwen35.txt 2>&1
```

The design above was committed as `97fac2e` before any run, and every run's app HEAD is that commit (v1.3.0).

- **The build.** That HEAD includes Task P's three commits, and the server binary was built from them. The bench
  builds nothing. Its chat-preset mirror and knob pin are `0b588af`.
- **The deadline knob.** `GATHERLIGHT_JUDGE_DEADLINE_SECONDS` was unset in the launching shell, and in the user and
  machine environments. The bench pinned it blank in every arm (each results file records `""` for all five arms),
  and no arm's log announces it. Every arm therefore ran the product's default 60 s deadline.
- **Timing.** The three runs took 05:39:12Z–05:44:19Z (Qwen3-0.6B), 05:44:22Z–05:50:58Z (gemma-3-270m) and
  05:51:01Z–05:55:49Z (Qwen3.5-0.8B).
- **Seed and order.** Run 1's seed, reused (fixture sha256 `9680443e…f555`); order seed 12345; five arms in parallel
  per run; latency sample 12.

**Every run is complete, and every guard held in every run**, checked by `devtools/_lc5b/guards5b.mjs` and the driver:

| guard | Qwen3-0.6B | gemma-3-270m | Qwen3.5-0.8B |
|---|---|---|---|
| formula digest | `f661eb6a056e` | `f661eb6a056e` | `f661eb6a056e` |
| rows, every arm | 240 + 12 latency | 240 + 12 latency | 240 + 12 latency |
| chat child's spawn args | `--reasoning off`, `--n-predict 512` | same | same |
| spawns / unloads / OOM | 1 each / 0 / 0 | 1 each / 0 / 0 | 1 each / 0 / 0 |
| chat tasks over 512 tokens | 0 | 0 | 0 |
| capped at 512 (`finish_reason: length`) | 16 of 494 | **64 of 494** | 15 of 494 |
| FTS fallbacks, any arm | 0 | 0 | 0 |
| deadline NoOpinions, any arm | 0 | 0 | 0 |
| claude-cli calls, any arm | 0 | 0 | 0 |
| llama.cpp chat calls ok / failed (`lc`, `lcb`) | 246/0, 246/0 | 246/0, 246/0 | 246/0, 246/0 |

- **The 60 s deadline was never reached.** No verification in any run came near it: the slowest judge-arm recall of the
  accuracy pass took 10.6 s. So this run did not exercise the deadline. It shows only that nothing fell back to FTS.
- **The cap was exercised.** Runaways happened in every run and were cut at 512 tokens, most often for gemma-3-270m.
  A capped reply is truncated JSON, which the verifier reads as no verdict. That is part of each arm's coverage below.
- **The instrument agreed with itself across the three runs.** The three `formula` arms share one digest. The three BGE
  arms are equivalent to each other, paired across runs by re-analysis (top-1 1/1 and 0/0; found@8 0/0 and 0/0), at
  90 / 203 each; Runs 4 and 5 read 90 / 204 and 91 / 204.

### The headline

`lc:` = content alone, the shipped input. Paired within each candidate's own run; against 公式, b = formula hit &
candidate miss; against BGE, b = BGE hit & candidate miss. Serial medians are over 12 queries, verdict-carrying
recalls only. The run's 公式 read 199–236 ms and BGE 418–435 ms.

| candidate (`lc:`) | bytes | coverage | top-1 / found@8 (公式 79 / 125) | top-1 vs 公式 | found@8 vs 公式 | top-1 vs BGE | found@8 vs BGE | serial median |
|---|---|---|---|---|---|---|---|---|
| **Qwen3-0.6B** | 639,446,688 | 226/234 (96.6%) | **110 / 148** | 8/39, p < 0.001, **+12.9pp** [+7.4, +18.2] | 4/27, p < 0.001, **+9.6pp** [+5.1, +13.9] | 9/29, p = 0.002, **+8.3pp** | 57/2, p < 0.001, −22.9pp | 381 ms |
| gemma-3-270m | 291,545,600 | 192/234 (82.1%) | 70 / 119 | 11/2, p = 0.022, **−3.8pp** [−6.7, −0.7] | 10/4, p = 0.180, −2.5pp [−5.6, +0.6] | 23/3, p < 0.001, −8.3pp | 85/1, p < 0.001, −35.0pp | 315 ms |
| Qwen3.5-0.8B | 833,592,096 | 228/234 (97.4%) | 87 / 135 | 26/34, p = 0.366, +3.3pp [−3.0, +9.6] | 16/26, p = 0.164, +4.2pp [−1.2, +9.4] | 30/27, p = 0.791, −1.3pp | 69/1, p < 0.001, −28.3pp | 447 ms |

### The decision rule, applied

- **Qwen3-0.6B (639,446,688 B): VIABLE to offer for 判断, and SIGNIFICANTLY BETTER than no judge on both metrics.**
  - top-1: 110 against 79, **+12.9pp**, p < 0.001, [+7.4, +18.2]pp.
  - found@8: 148 against 125, **+9.6pp**, p < 0.001, [+5.1, +13.9]pp.
  - Coverage 96.6%. No set is significantly against it (below), and `lcb:` is significantly better on both too.
  - Against BGE, the reference: **significantly better on top-1** (+8.3pp, p = 0.002) and significantly worse on found@8
    (−22.9pp). It puts the answer FIRST more often than the reranker does; the reranker puts it ON THE PAGE far more
    often.
- **gemma-3-270m-it (291,545,600 B): NOT viable.** It is significantly worse than no judge on top-1: 11/2, p = 0.022,
  **−3.8pp**, [−6.7, −0.7]pp.
  - Its found@8 shows no significant difference (10/4, p = 0.180).
  - Coverage 82.1%.
  - `lcb:` is significantly worse on top-1 as well (12/2, p = 0.013).
- **Qwen3.5-0.8B (833,592,096 B): VIABLE to offer for 判断**, with **no significant difference** from no judge on either
  metric.
  - top-1: +3.3pp, p = 0.366; the run cannot rule out a loss of up to 3.0pp.
  - found@8: +4.2pp, p = 0.164; it cannot rule out a loss of up to 1.2pp.
  - Coverage 97.4%, so it is not "mostly inert". `lcb:` passes too.
  - Against BGE: no significant difference on top-1 (p = 0.791), and significantly worse on found@8 (−28.3pp).
- This is the same outcome Qwen3.5 had in Run 5 ("no significant difference" on both). Reading the two runs side by
  side is descriptive only.

### Qwen3-0.6B — accuracy, the four sets and `all`

```
== same ==
arm                                                 n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)          60   0    60     0       0         42/60     54/60     0.769   295
reranker bge-reranker-v2-m3-Q5_K_M · partition      60   0    60     60      60        43/60     57/60     0.808   508            +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse           60   0    60     60      60        42/60     55/60     0.790   510            +0 / +1 / +0.021
local chat judge Qwen3-0.6B-Q8_0 · content only     60   0    60     59      59        45/60     57/60     0.833   808            +3 / +3 / +0.065
local chat judge Qwen3-0.6B-Q8_0 · topic — content  60   0    60     59      59        40/60     56/60     0.775   842            -2 / +2 / +0.006

== cross ==
arm                                                 n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)          60   0    60     0       0         1/60      6/60      0.042   360
reranker bge-reranker-v2-m3-Q5_K_M · partition      60   0    60     60      60        3/60      48/60     0.220   665            +2 / +42 / +0.178
reranker bge-reranker-v2-m3-Q5_K_M · fuse           60   0    60     60      60        2/60      12/60     0.071   605            +1 / +6 / +0.030
local chat judge Qwen3-0.6B-Q8_0 · content only     60   0    60     56      56        10/60     19/60     0.211   1262           +9 / +13 / +0.169
local chat judge Qwen3-0.6B-Q8_0 · topic — content  60   0    60     58      58        10/60     20/60     0.226   1055           +9 / +14 / +0.184

== third ==
arm                                                 n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)          60   0    55     0       0         1/60      18/60     0.119   314
reranker bge-reranker-v2-m3-Q5_K_M · partition      60   0    55     55      55        8/60      42/60     0.286   519            +7 / +24 / +0.167
reranker bge-reranker-v2-m3-Q5_K_M · fuse           60   0    55     55      55        7/60      21/60     0.200   564            +6 / +3 / +0.081
local chat judge Qwen3-0.6B-Q8_0 · content only     60   0    55     54      54        13/60     23/60     0.278   851            +12 / +5 / +0.159
local chat judge Qwen3-0.6B-Q8_0 · topic — content  60   0    55     49      49        12/60     24/60     0.289   1097           +11 / +6 / +0.170

== mixed ==
arm                                                 n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)          60   0    59     0       0         35/60     47/60     0.657   374
reranker bge-reranker-v2-m3-Q5_K_M · partition      60   0    59     59      59        36/60     56/60     0.712   618            +1 / +9 / +0.055
reranker bge-reranker-v2-m3-Q5_K_M · fuse           60   0    59     59      59        36/60     50/60     0.694   638            +1 / +3 / +0.037
local chat judge Qwen3-0.6B-Q8_0 · content only     60   0    59     57      57        42/60     49/60     0.744   1082           +7 / +2 / +0.088
local chat judge Qwen3-0.6B-Q8_0 · topic — content  60   0    59     55      55        43/60     52/60     0.774   1355           +8 / +5 / +0.117

== all ==
arm                                                 n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)          240  0    234    0       0         79/240    125/240   0.397   336
reranker bge-reranker-v2-m3-Q5_K_M · partition      240  0    234    234     234       90/240    203/240   0.506   577            +11 / +78 / +0.110
reranker bge-reranker-v2-m3-Q5_K_M · fuse           240  0    234    234     234       87/240    138/240   0.439   579            +8 / +13 / +0.042
local chat judge Qwen3-0.6B-Q8_0 · content only     240  0    234    226     226       110/240   148/240   0.517   1001           +31 / +23 / +0.120
local chat judge Qwen3-0.6B-Q8_0 · topic — content  240  0    234    221     221       105/240   152/240   0.516   1087           +26 / +27 / +0.119
```

### Qwen3-0.6B — paired vs `formula`

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
PAIRED vs formula — per query; b = formula hit & arm miss, c = formula miss & arm hit
  top-1:
  arm                                                 set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition      all     240    3/14     0.013   +11 (+4.6pp)     [+1.2, +7.9]pp      no          YES (arm better)
                                                      same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                      cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                      third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                      mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse           all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                      same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                      cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                      third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —
                                                      mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  local chat judge Qwen3-0.6B-Q8_0 · content only     all     240    8/39     <0.001  +31 (+12.9pp)    [+7.4, +18.2]pp     no          YES (arm better)
                                                      same    60     5/8      0.581   +3 (+5.0pp)      [-6.9, +16.6]pp     —
                                                      cross   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
                                                      third   60     1/13     0.002   +12 (+20.0pp)    [+8.1, +30.6]pp     —
                                                      mixed   60     2/9      0.065   +7 (+11.7pp)     [+0.7, +21.9]pp     —
  local chat judge Qwen3-0.6B-Q8_0 · topic — content  all     240    8/34     <0.001  +26 (+10.8pp)    [+5.6, +15.9]pp     no          YES (arm better)
                                                      same    60     8/6      0.791   -2 (-3.3pp)      [-15.4, +9.0]pp     —
                                                      cross   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
                                                      third   60     0/11     <0.001  +11 (+18.3pp)    [+7.7, +27.8]pp     —
                                                      mixed   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —
  found@8:
  arm                                                 set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition      all     240    1/79     <0.001  +78 (+32.5pp)    [+26.2, +38.3]pp    no          YES (arm better)
                                                      same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                      cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —
                                                      third   60     1/25     <0.001  +24 (+40.0pp)    [+25.4, +52.0]pp    —
                                                      mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse           all     240    5/18     0.011   +13 (+5.4pp)     [+1.5, +9.3]pp      no          YES (arm better)
                                                      same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                      cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —
                                                      third   60     2/5      0.453   +3 (+5.0pp)      [-4.0, +13.7]pp     —
                                                      mixed   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
  local chat judge Qwen3-0.6B-Q8_0 · content only     all     240    4/27     <0.001  +23 (+9.6pp)     [+5.1, +13.9]pp     no          YES (arm better)
                                                      same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                      cross   60     2/15     0.002   +13 (+21.7pp)    [+8.6, +33.3]pp     —
                                                      third   60     2/7      0.180   +5 (+8.3pp)      [-1.7, +17.9]pp     —
                                                      mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
  local chat judge Qwen3-0.6B-Q8_0 · topic — content  all     240    3/30     <0.001  +27 (+11.3pp)    [+6.6, +15.7]pp     no          YES (arm better)
                                                      same    60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —
                                                      cross   60     0/14     <0.001  +14 (+23.3pp)    [+11.7, +33.5]pp    —
                                                      third   60     2/8      0.109   +6 (+10.0pp)     [-0.5, +19.9]pp     —
                                                      mixed   60     0/5      0.063   +5 (+8.3pp)      [+0.6, +15.5]pp     —
```

### Qwen3-0.6B — against BGE, and `lc` against `lcb`

```
PAIRED — each local chat judge against each reranker under partition; b = reranker hit & chat-judge miss, c = the reverse
  top-1:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    9/29     0.002   +20 (+8.3pp)     [+3.3, +13.2]pp     no          YES (arm better)
                                                       same    60     4/6      0.754   +2 (+3.3pp)      [-7.2, +13.7]pp     —
                                                       cross   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                       third   60     3/8      0.227   +5 (+8.3pp)      [-2.7, +18.8]pp     —
                                                       mixed   60     2/8      0.109   +6 (+10.0pp)     [-0.5, +19.9]pp     —
  lcb:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    11/26    0.020   +15 (+6.3pp)     [+1.3, +11.1]pp     no          YES (arm better)
                                                       same    60     9/6      0.607   -3 (-5.0pp)      [-17.4, +7.7]pp     —
                                                       cross   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                       third   60     2/6      0.289   +4 (+6.7pp)      [-2.9, +15.8]pp     —
                                                       mixed   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
  found@8:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    57/2     <0.001  -55 (-22.9pp)    [-28.3, -17.1]pp    no          YES (arm worse)
                                                       same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                       cross   60     30/1     <0.001  -29 (-48.3pp)    [-60.3, -33.2]pp    —
                                                       third   60     20/1     <0.001  -19 (-31.7pp)    [-43.4, -17.9]pp    —
                                                       mixed   60     7/0      0.016   -7 (-11.7pp)     [-19.8, -2.8]pp     —
  lcb:Qwen3-0.6B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    53/2     <0.001  -51 (-21.3pp)    [-26.5, -15.6]pp    no          YES (arm worse)
                                                       same    60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                       cross   60     28/0     <0.001  -28 (-46.7pp)    [-57.9, -32.4]pp    —
                                                       third   60     19/1     <0.001  -18 (-30.0pp)    [-41.6, -16.5]pp    —
                                                       mixed   60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —

PAIRED — each local chat judge, content only (lc) against topic — content (lcb); b = lcb hit & lc miss, c = the reverse
  top-1:
  arm                                        set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3-0.6B-Q8_0 vs lcb:Qwen3-0.6B-Q8_0  all     240    15/20    0.500   +5 (+2.1pp)      [-2.8, +6.9]pp      no          no
                                             same    60     3/8      0.227   +5 (+8.3pp)      [-2.7, +18.8]pp     —
                                             cross   60     3/3      1.000   +0 (+0.0pp)      [-8.4, +8.4]pp      —
                                             third   60     6/7      1.000   +1 (+1.7pp)      [-10.2, +13.4]pp    —
                                             mixed   60     3/2      1.000   -1 (-1.7pp)      [-9.3, +6.1]pp      —
  found@8:
  arm                                        set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3-0.6B-Q8_0 vs lcb:Qwen3-0.6B-Q8_0  all     240    15/11    0.557   -4 (-1.7pp)      [-5.9, +2.6]pp      no          no
                                             same    60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                             cross   60     6/5      1.000   -1 (-1.7pp)      [-12.6, +9.3]pp     —
                                             third   60     6/5      1.000   -1 (-1.7pp)      [-12.6, +9.3]pp     —
                                             mixed   60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —
```

### gemma-3-270m — accuracy, the four sets and `all`

```
== same ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         42/60     54/60     0.769   305
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    60     60      60        43/60     57/60     0.808   459            +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    60     60      60        42/60     55/60     0.790   463            +0 / +1 / +0.021
local chat judge gemma-3-270m-it-Q8_0 · content only     60   0    60     54      52        35/60     50/60     0.658   1388           -7 / -4 / -0.110
local chat judge gemma-3-270m-it-Q8_0 · topic — content  60   0    60     52      49        34/60     50/60     0.647   1357           -8 / -4 / -0.122

== cross ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    60     0       0         1/60      6/60      0.042   374
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    60     60      60        3/60      48/60     0.221   606            +2 / +42 / +0.179
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    60     60      60        2/60      12/60     0.071   590            +1 / +6 / +0.030
local chat judge gemma-3-270m-it-Q8_0 · content only     60   0    60     43      42        1/60      5/60      0.037   1810           +0 / -1 / -0.004
local chat judge gemma-3-270m-it-Q8_0 · topic — content  60   0    60     48      47        1/60      6/60      0.046   1792           +0 / +0 / +0.005

== third ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    55     0       0         1/60      18/60     0.119   327
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    55     55      55        7/60      42/60     0.274   505            +6 / +24 / +0.155
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    55     55      55        8/60      21/60     0.209   503            +7 / +3 / +0.089
local chat judge gemma-3-270m-it-Q8_0 · content only     60   0    55     49      47        1/60      18/60     0.100   1066           +0 / +0 / -0.019
local chat judge gemma-3-270m-it-Q8_0 · topic — content  60   0    55     51      50        1/60      16/60     0.087   1089           +0 / -2 / -0.032

== mixed ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               60   0    59     0       0         35/60     47/60     0.657   351
reranker bge-reranker-v2-m3-Q5_K_M · partition           60   0    59     59      59        37/60     56/60     0.720   579            +2 / +9 / +0.063
reranker bge-reranker-v2-m3-Q5_K_M · fuse                60   0    59     59      59        35/60     51/60     0.681   588            +0 / +4 / +0.024
local chat judge gemma-3-270m-it-Q8_0 · content only     60   0    59     46      46        33/60     46/60     0.617   1615           -2 / -1 / -0.040
local chat judge gemma-3-270m-it-Q8_0 · topic — content  60   0    59     47      45        33/60     47/60     0.620   1473           -2 / +0 / -0.037

== all ==
arm                                                      n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)               240  0    234    0       0         79/240    125/240   0.397   339
reranker bge-reranker-v2-m3-Q5_K_M · partition           240  0    234    234     234       90/240    203/240   0.506   537            +11 / +78 / +0.109
reranker bge-reranker-v2-m3-Q5_K_M · fuse                240  0    234    234     234       87/240    139/240   0.438   536            +8 / +14 / +0.041
local chat judge gemma-3-270m-it-Q8_0 · content only     240  0    234    192     187       70/240    119/240   0.353   1470           -9 / -6 / -0.043
local chat judge gemma-3-270m-it-Q8_0 · topic — content  240  0    234    198     191       69/240    119/240   0.350   1427           -10 / -6 / -0.047
```

### gemma-3-270m — paired vs `formula`

```
PAIRED vs formula — per query; b = formula hit & arm miss, c = formula miss & arm hit
  top-1:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    3/14     0.013   +11 (+4.6pp)     [+1.2, +7.9]pp      no          YES (arm better)
                                                           same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                           cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                           third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —
                                                           mixed   60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                           same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                           cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                           third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                           mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
  local chat judge gemma-3-270m-it-Q8_0 · content only     all     240    11/2     0.022   -9 (-3.8pp)      [-6.7, -0.7]pp      no          YES (arm worse)
                                                           same    60     8/1      0.039   -7 (-11.7pp)     [-20.9, -1.7]pp     —
                                                           cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                           third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                           mixed   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
  local chat judge gemma-3-270m-it-Q8_0 · topic — content  all     240    12/2     0.013   -10 (-4.2pp)     [-7.2, -1.0]pp      no          YES (arm worse)
                                                           same    60     9/1      0.021   -8 (-13.3pp)     [-22.9, -2.9]pp     —
                                                           cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                           third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                           mixed   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —
  found@8:
  arm                                                      set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition           all     240    1/79     <0.001  +78 (+32.5pp)    [+26.2, +38.3]pp    no          YES (arm better)
                                                           same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                           cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —
                                                           third   60     1/25     <0.001  +24 (+40.0pp)    [+25.4, +52.0]pp    —
                                                           mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse                all     240    5/19     0.007   +14 (+5.8pp)     [+1.8, +9.8]pp      no          YES (arm better)
                                                           same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                           cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —
                                                           third   60     2/5      0.453   +3 (+5.0pp)      [-4.0, +13.7]pp     —
                                                           mixed   60     0/4      0.125   +4 (+6.7pp)      [-0.4, +13.3]pp     —
  local chat judge gemma-3-270m-it-Q8_0 · content only     all     240    10/4     0.180   -6 (-2.5pp)      [-5.6, +0.6]pp      no          no
                                                           same    60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
                                                           cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                           third   60     3/3      1.000   +0 (+0.0pp)      [-8.4, +8.4]pp      —
                                                           mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
  local chat judge gemma-3-270m-it-Q8_0 · topic — content  all     240    8/2      0.109   -6 (-2.5pp)      [-5.1, +0.2]pp      no          no
                                                           same    60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
                                                           cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                           third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —
                                                           mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
```

### gemma-3-270m — against BGE, and `lc` against `lcb`

```
PAIRED — each local chat judge against each reranker under partition; b = reranker hit & chat-judge miss, c = the reverse
  top-1:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    23/3     <0.001  -20 (-8.3pp)     [-12.3, -4.2]pp     no          YES (arm worse)
                                                            same    60     10/2     0.039   -8 (-13.3pp)     [-23.8, -2.0]pp     —
                                                            cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —
                                                            third   60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —
                                                            mixed   60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
  lcb:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    23/2     <0.001  -21 (-8.8pp)     [-12.7, -4.7]pp     no          YES (arm worse)
                                                            same    60     10/1     0.012   -9 (-15.0pp)     [-24.9, -4.2]pp     —
                                                            cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —
                                                            third   60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —
                                                            mixed   60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
  found@8:
  arm                                                       set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    85/1     <0.001  -84 (-35.0pp)    [-40.9, -28.6]pp    no          YES (arm worse)
                                                            same    60     7/0      0.016   -7 (-11.7pp)     [-19.8, -2.8]pp     —
                                                            cross   60     43/0     <0.001  -43 (-71.7pp)    [-81.3, -57.5]pp    —
                                                            third   60     25/1     <0.001  -24 (-40.0pp)    [-52.0, -25.4]pp    —
                                                            mixed   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —
  lcb:gemma-3-270m-it-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    84/0     <0.001  -84 (-35.0pp)    [-40.8, -28.7]pp    no          YES (arm worse)
                                                            same    60     7/0      0.016   -7 (-11.7pp)     [-19.8, -2.8]pp     —
                                                            cross   60     42/0     <0.001  -42 (-70.0pp)    [-79.8, -55.7]pp    —
                                                            third   60     26/0     <0.001  -26 (-43.3pp)    [-54.6, -29.3]pp    —
                                                            mixed   60     9/0      0.004   -9 (-15.0pp)     [-23.8, -5.2]pp     —

PAIRED — each local chat judge, content only (lc) against topic — content (lcb); b = lcb hit & lc miss, c = the reverse
  top-1:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-270m-it-Q8_0 vs lcb:gemma-3-270m-it-Q8_0  all     240    2/3      1.000   +1 (+0.4pp)      [-1.6, +2.4]pp      YES         no
                                                       same    60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
                                                       cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                       third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —
                                                       mixed   60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
  found@8:
  arm                                                  set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:gemma-3-270m-it-Q8_0 vs lcb:gemma-3-270m-it-Q8_0  all     240    4/4      1.000   +0 (+0.0pp)      [-2.4, +2.4]pp      YES         no
                                                       same    60     1/1      1.000   +0 (+0.0pp)      [-5.5, +5.5]pp      —
                                                       cross   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
                                                       third   60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —
                                                       mixed   60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —
```

### Qwen3.5-0.8B — accuracy, the four sets and `all`

```
== same ==
arm                                                   n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)            60   0    60     0       0         42/60     54/60     0.769   303
reranker bge-reranker-v2-m3-Q5_K_M · partition        60   0    60     60      60        43/60     57/60     0.808   504            +1 / +3 / +0.039
reranker bge-reranker-v2-m3-Q5_K_M · fuse             60   0    60     60      60        42/60     55/60     0.790   540            +0 / +1 / +0.021
local chat judge Qwen3.5-0.8B-Q8_0 · content only     60   0    60     59      55        33/60     51/60     0.630   788            -9 / -3 / -0.139
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  60   0    60     55      53        32/60     50/60     0.626   933            -10 / -4 / -0.142

== cross ==
arm                                                   n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)            60   0    60     0       0         1/60      6/60      0.042   363
reranker bge-reranker-v2-m3-Q5_K_M · partition        60   0    60     60      60        3/60      48/60     0.220   769            +2 / +42 / +0.178
reranker bge-reranker-v2-m3-Q5_K_M · fuse             60   0    60     60      60        2/60      12/60     0.071   752            +1 / +6 / +0.030
local chat judge Qwen3.5-0.8B-Q8_0 · content only     60   0    60     59      55        10/60     17/60     0.217   976            +9 / +11 / +0.175
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  60   0    60     58      57        8/60      20/60     0.194   1027           +7 / +14 / +0.152

== third ==
arm                                                   n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)            60   0    55     0       0         1/60      18/60     0.119   315
reranker bge-reranker-v2-m3-Q5_K_M · partition        60   0    55     55      55        8/60      42/60     0.290   654            +7 / +24 / +0.171
reranker bge-reranker-v2-m3-Q5_K_M · fuse             60   0    55     55      55        7/60      21/60     0.200   623            +6 / +3 / +0.081
local chat judge Qwen3.5-0.8B-Q8_0 · content only     60   0    55     53      49        12/60     19/60     0.247   830            +11 / +1 / +0.128
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  60   0    55     52      46        6/60      21/60     0.190   883            +5 / +3 / +0.071

== mixed ==
arm                                                   n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)            60   0    59     0       0         35/60     47/60     0.657   362
reranker bge-reranker-v2-m3-Q5_K_M · partition        60   0    59     59      59        36/60     56/60     0.712   744            +1 / +9 / +0.055
reranker bge-reranker-v2-m3-Q5_K_M · fuse             60   0    59     59      59        36/60     50/60     0.694   735            +1 / +3 / +0.037
local chat judge Qwen3.5-0.8B-Q8_0 · content only     60   0    59     57      55        32/60     48/60     0.611   1105           -3 / +1 / -0.046
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  60   0    59     56      55        31/60     46/60     0.594   1197           -4 / -1 / -0.063

== all ==
arm                                                   n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)            240  0    234    0       0         79/240    125/240   0.397   336
reranker bge-reranker-v2-m3-Q5_K_M · partition        240  0    234    234     234       90/240    203/240   0.508   668            +11 / +78 / +0.111
reranker bge-reranker-v2-m3-Q5_K_M · fuse             240  0    234    234     234       87/240    138/240   0.439   663            +8 / +13 / +0.042
local chat judge Qwen3.5-0.8B-Q8_0 · content only     240  0    234    228     214       87/240    135/240   0.426   925            +8 / +10 / +0.030
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  240  0    234    221     211       77/240    137/240   0.401   1010           -2 / +12 / +0.004
```

### Qwen3.5-0.8B — paired vs `formula`

```
PAIRED vs formula — per query; b = formula hit & arm miss, c = formula miss & arm hit
  top-1:
  arm                                                   set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition        all     240    3/14     0.013   +11 (+4.6pp)     [+1.2, +7.9]pp      no          YES (arm better)
                                                        same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                        cross   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —
                                                        third   60     0/7      0.016   +7 (+11.7pp)     [+2.8, +19.8]pp     —
                                                        mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse             all     240    3/11     0.057   +8 (+3.3pp)      [+0.2, +6.4]pp      no          no
                                                        same    60     2/2      1.000   +0 (+0.0pp)      [-7.1, +7.1]pp      —
                                                        cross   60     0/1      1.000   +1 (+1.7pp)      [-2.8, +6.1]pp      —
                                                        third   60     0/6      0.031   +6 (+10.0pp)     [+1.7, +17.7]pp     —
                                                        mixed   60     1/2      1.000   +1 (+1.7pp)      [-4.7, +7.9]pp      —
  local chat judge Qwen3.5-0.8B-Q8_0 · content only     all     240    26/34    0.366   +8 (+3.3pp)      [-3.0, +9.6]pp      no          no
                                                        same    60     14/5     0.064   -9 (-15.0pp)     [-28.2, -0.8]pp     —
                                                        cross   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
                                                        third   60     1/12     0.003   +11 (+18.3pp)    [+6.8, +28.7]pp     —
                                                        mixed   60     11/8     0.648   -3 (-5.0pp)      [-18.9, +9.2]pp     —
  local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  all     240    28/26    0.892   -2 (-0.8pp)      [-6.8, +5.2]pp      no          no
                                                        same    60     16/6     0.052   -10 (-16.7pp)    [-30.7, -1.5]pp     —
                                                        cross   60     1/8      0.039   +7 (+11.7pp)     [+1.7, +20.9]pp     —
                                                        third   60     1/6      0.125   +5 (+8.3pp)      [-0.6, +16.8]pp     —
                                                        mixed   60     10/6     0.454   -4 (-6.7pp)      [-19.4, +6.5]pp     —
  found@8:
  arm                                                   set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  reranker bge-reranker-v2-m3-Q5_K_M · partition        all     240    1/79     <0.001  +78 (+32.5pp)    [+26.2, +38.3]pp    no          YES (arm better)
                                                        same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
                                                        cross   60     0/42     <0.001  +42 (+70.0pp)    [+55.7, +79.8]pp    —
                                                        third   60     1/25     <0.001  +24 (+40.0pp)    [+25.4, +52.0]pp    —
                                                        mixed   60     0/9      0.004   +9 (+15.0pp)     [+5.2, +23.8]pp     —
  reranker bge-reranker-v2-m3-Q5_K_M · fuse             all     240    5/18     0.011   +13 (+5.4pp)     [+1.5, +9.3]pp      no          YES (arm better)
                                                        same    60     2/3      1.000   +1 (+1.7pp)      [-6.1, +9.3]pp      —
                                                        cross   60     1/7      0.070   +6 (+10.0pp)     [+0.5, +18.9]pp     —
                                                        third   60     2/5      0.453   +3 (+5.0pp)      [-4.0, +13.7]pp     —
                                                        mixed   60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —
  local chat judge Qwen3.5-0.8B-Q8_0 · content only     all     240    16/26    0.164   +10 (+4.2pp)     [-1.2, +9.4]pp      no          no
                                                        same    60     5/2      0.453   -3 (-5.0pp)      [-13.7, +4.0]pp     —
                                                        cross   60     1/12     0.003   +11 (+18.3pp)    [+6.8, +28.7]pp     —
                                                        third   60     6/7      1.000   +1 (+1.7pp)      [-10.2, +13.4]pp    —
                                                        mixed   60     4/5      1.000   +1 (+1.7pp)      [-8.4, +11.6]pp     —
  local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  all     240    16/28    0.096   +12 (+5.0pp)     [-0.4, +10.4]pp     no          no
                                                        same    60     5/1      0.219   -4 (-6.7pp)      [-14.7, +1.8]pp     —
                                                        cross   60     3/17     0.003   +14 (+23.3pp)    [+9.2, +35.9]pp     —
                                                        third   60     4/7      0.549   +3 (+5.0pp)      [-6.0, +15.7]pp     —
                                                        mixed   60     4/3      1.000   -1 (-1.7pp)      [-10.5, +7.3]pp     —
```

### Qwen3.5-0.8B — against BGE, and `lc` against `lcb`

```
PAIRED — each local chat judge against each reranker under partition; b = reranker hit & chat-judge miss, c = the reverse
  top-1:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    30/27    0.791   -3 (-1.3pp)      [-7.4, +4.9]pp      no          no
                                                         same    60     14/4     0.031   -10 (-16.7pp)    [-29.3, -2.9]pp     —
                                                         cross   60     1/8      0.039   +7 (+11.7pp)     [+1.7, +20.9]pp     —
                                                         third   60     4/8      0.388   +4 (+6.7pp)      [-4.8, +17.7]pp     —
                                                         mixed   60     11/7     0.481   -4 (-6.7pp)      [-20.1, +7.2]pp     —
  lcb:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    38/25    0.130   -13 (-5.4pp)     [-11.8, +1.1]pp     no          no
                                                         same    60     17/6     0.035   -11 (-18.3pp)    [-32.6, -2.9]pp     —
                                                         cross   60     2/7      0.180   +5 (+8.3pp)      [-1.7, +17.9]pp     —
                                                         third   60     7/5      0.774   -2 (-3.3pp)      [-14.6, +8.1]pp     —
                                                         mixed   60     12/7     0.359   -5 (-8.3pp)      [-22.1, +5.9]pp     —
  found@8:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M   all     240    69/1     <0.001  -68 (-28.3pp)    [-33.9, -22.3]pp    no          YES (arm worse)
                                                         same    60     6/0      0.031   -6 (-10.0pp)     [-17.7, -1.7]pp     —
                                                         cross   60     31/0     <0.001  -31 (-51.7pp)    [-62.8, -37.2]pp    —
                                                         third   60     24/1     <0.001  -23 (-38.3pp)    [-50.3, -23.9]pp    —
                                                         mixed   60     8/0      0.008   -8 (-13.3pp)     [-21.8, -4.0]pp     —
  lcb:Qwen3.5-0.8B-Q8_0 vs rr:bge-reranker-v2-m3-Q5_K_M  all     240    68/2     <0.001  -66 (-27.5pp)    [-33.2, -21.4]pp    no          YES (arm worse)
                                                         same    60     7/0      0.016   -7 (-11.7pp)     [-19.8, -2.8]pp     —
                                                         cross   60     29/1     <0.001  -28 (-46.7pp)    [-58.7, -31.6]pp    —
                                                         third   60     22/1     <0.001  -21 (-35.0pp)    [-46.9, -20.9]pp    —
                                                         mixed   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —

PAIRED — each local chat judge, content only (lc) against topic — content (lcb); b = lcb hit & lc miss, c = the reverse
  top-1:
  arm                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs lcb:Qwen3.5-0.8B-Q8_0  all     240    32/42    0.295   +10 (+4.2pp)     [-2.9, +11.1]pp     no          no
                                                 same    60     12/13    1.000   +1 (+1.7pp)      [-14.5, +17.7]pp    —
                                                 cross   60     5/7      0.774   +2 (+3.3pp)      [-8.1, +14.6]pp     —
                                                 third   60     2/8      0.109   +6 (+10.0pp)     [-0.5, +19.9]pp     —
                                                 mixed   60     13/14    1.000   +1 (+1.7pp)      [-15.1, +18.3]pp    —
  found@8:
  arm                                            set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  lc:Qwen3.5-0.8B-Q8_0 vs lcb:Qwen3.5-0.8B-Q8_0  all     240    26/24    0.888   -2 (-0.8pp)      [-6.6, +5.0]pp      no          no
                                                 same    60     4/5      1.000   +1 (+1.7pp)      [-8.4, +11.6]pp     —
                                                 cross   60     11/8     0.648   -3 (-5.0pp)      [-18.9, +9.2]pp     —
                                                 third   60     7/5      0.774   -2 (-3.3pp)      [-14.6, +8.1]pp     —
                                                 mixed   60     4/6      0.754   +2 (+3.3pp)      [-7.2, +13.7]pp     —
```

### Latency — the clean serial pass

Each run's serial pass ran after its accuracy pass, one arm at a time, over the first 12 queries in the shared order.
Two models were resident, as in the product, and nothing else ran on the router. **These are the latency figures.**

Qwen3-0.6B:

```
latency (ms) — parallel: mean over the accuracy pass, 5 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                 ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)          336            220                 0/0                       0/0                    off · claude-cli · haiku
reranker bge-reranker-v2-m3-Q5_K_M · partition      577            418                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · fuse           579            390                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
local chat judge Qwen3-0.6B-Q8_0 · content only     1001           381                 0/0                       0/0                    on · llama-cpp · Qwen3-0.6B-Q8_0
local chat judge Qwen3-0.6B-Q8_0 · topic — content  1087           384                 0/0                       0/0                    on · llama-cpp · Qwen3-0.6B-Q8_0

llama.cpp chat calls (router: llamacpp) — ok/failed per pass; a local chat judge's verdicts arrive through these
arm                                                 startup     accuracy pass   latency pass
local chat judge Qwen3-0.6B-Q8_0 · content only     0/0         234/0           12/0
local chat judge Qwen3-0.6B-Q8_0 · topic — content  0/0         234/0           12/0

local chat judge latency (ms), EVERY graph-ranked recall, verdict or not — serial pass, and the accuracy pass (parallel, contended)
arm                                                 serial median  serial max  no verdict: n · median  parallel max  parallel ≥ 60 s parallel no-verdict median
local chat judge Qwen3-0.6B-Q8_0 · content only     411            2557        1 · 2557                8336          0/234           5835
local chat judge Qwen3-0.6B-Q8_0 · topic — content  384            854         0 · —                   9110          0/234           5313
```

gemma-3-270m:

```
latency (ms) — parallel: mean over the accuracy pass, 5 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                      ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)               339            236                 0/0                       0/0                    off · claude-cli · haiku
reranker bge-reranker-v2-m3-Q5_K_M · partition           537            429                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · fuse                536            406                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
local chat judge gemma-3-270m-it-Q8_0 · content only     1470           315                 0/0                       0/0                    on · llama-cpp · gemma-3-270m-it-Q8_0
local chat judge gemma-3-270m-it-Q8_0 · topic — content  1427           328                 0/0                       0/0                    on · llama-cpp · gemma-3-270m-it-Q8_0

llama.cpp chat calls (router: llamacpp) — ok/failed per pass; a local chat judge's verdicts arrive through these
arm                                                      startup     accuracy pass   latency pass
local chat judge gemma-3-270m-it-Q8_0 · content only     0/0         234/0           12/0
local chat judge gemma-3-270m-it-Q8_0 · topic — content  0/0         234/0           12/0

local chat judge latency (ms), EVERY graph-ranked recall, verdict or not — serial pass, and the accuracy pass (parallel, contended)
arm                                                      serial median  serial max  no verdict: n · median  parallel max  parallel ≥ 60 s parallel no-verdict median
local chat judge gemma-3-270m-it-Q8_0 · content only     315            733         0 · —                   7712          0/234           4091
local chat judge gemma-3-270m-it-Q8_0 · topic — content  328            635         0 · —                   7375          0/234           4243
```

Qwen3.5-0.8B:

```
latency (ms) — parallel: mean over the accuracy pass, 5 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                   ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)            336            199                 0/0                       0/0                    off · claude-cli · haiku
reranker bge-reranker-v2-m3-Q5_K_M · partition        668            435                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
reranker bge-reranker-v2-m3-Q5_K_M · fuse             663            404                 0/0                       0/0                    on · llama-cpp · bge-reranker-v2-m3-Q5_K_M
local chat judge Qwen3.5-0.8B-Q8_0 · content only     925            447                 0/0                       0/0                    on · llama-cpp · Qwen3.5-0.8B-Q8_0
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  1010           443                 0/0                       0/0                    on · llama-cpp · Qwen3.5-0.8B-Q8_0

llama.cpp chat calls (router: llamacpp) — ok/failed per pass; a local chat judge's verdicts arrive through these
arm                                                   startup     accuracy pass   latency pass
local chat judge Qwen3.5-0.8B-Q8_0 · content only     0/0         234/0           12/0
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  0/0         234/0           12/0

local chat judge latency (ms), EVERY graph-ranked recall, verdict or not — serial pass, and the accuracy pass (parallel, contended)
arm                                                   serial median  serial max  no verdict: n · median  parallel max  parallel ≥ 60 s parallel no-verdict median
local chat judge Qwen3.5-0.8B-Q8_0 · content only     453            3013        1 · 3013                5612          0/234           4305
local chat judge Qwen3.5-0.8B-Q8_0 · topic — content  440            938         1 · 165                 10576         0/234           4129
```

- **A verdict adds** about +0.16 s per recall for Qwen3-0.6B (381 against 220 ms), +0.08 s for gemma-3-270m (315
  against 236) and +0.25 s for Qwen3.5-0.8B (447 against 199). BGE adds about +0.19–0.24 s.
- **Counting every graph recall, verdict or not:** the medians are 411 / 315 / 453 ms, and the slowest serial recall
  took 2.6 / 0.7 / 3.0 s.
- **The parallel means** (925–1,470 ms) were five arms at once and are not latency.

### Warnings, as printed

```
WARNING: arm lc:Qwen3-0.6B-Q8_0 — judge failed open on 8/234 graph recalls
WARNING: arm lc:Qwen3-0.6B-Q8_0 — 1/12 graph-ranked latency recalls carried no verdict (left out of its serial median)
WARNING: arm lcb:Qwen3-0.6B-Q8_0 — judge failed open on 13/234 graph recalls
WARNING: arm lc:gemma-3-270m-it-Q8_0 — judge failed open on 42/234 graph recalls
WARNING: arm lcb:gemma-3-270m-it-Q8_0 — judge failed open on 36/234 graph recalls
WARNING: arm lc:Qwen3.5-0.8B-Q8_0 — judge failed open on 6/234 graph recalls
WARNING: arm lc:Qwen3.5-0.8B-Q8_0 — 1/12 graph-ranked latency recalls carried no verdict (left out of its serial median)
WARNING: arm lcb:Qwen3.5-0.8B-Q8_0 — judge failed open on 13/234 graph recalls
WARNING: arm lcb:Qwen3.5-0.8B-Q8_0 — 1/12 graph-ranked latency recalls carried no verdict (left out of its serial median)
```

Each "failed open" is a graph recall with no verdict, that is, a reply the verifier could not read. Every llama.cpp
call returned Ok, so none was a transport failure. They include the capped runaways above. Coverage is stated with
every outcome.

### Secondary, pre-registered, outside the rule — only the recalls that carried a verdict

| arm | judged | top-1 b/c, p, net | found@8 b/c, p, net |
|---|---|---|---|
| Qwen3-0.6B `lc:` | 226 | 8/39, p < 0.001, +13.7pp | 4/27, p < 0.001, +10.2pp |
| Qwen3-0.6B `lcb:` | 221 | 8/34, p < 0.001, +11.8pp | 3/29, p < 0.001, +11.8pp |
| gemma-3-270m `lc:` | 192 | 10/2, p = 0.039, −4.2pp | 8/3, p = 0.227, −2.6pp |
| gemma-3-270m `lcb:` | 198 | 11/2, p = 0.022, −4.5pp | 7/2, p = 0.180, −2.5pp |
| Qwen3.5-0.8B `lc:` | 228 | 26/34, p = 0.366, +3.5pp | 16/26, p = 0.164, +4.4pp |
| Qwen3.5-0.8B `lcb:` | 221 | 27/26, p = 1.000, −0.5pp | 16/28, p = 0.096, +5.4pp |

The judged-only reading agrees in direction with every arm's full reading. None of the three candidates' results
depends on its abstentions.

### Across runs — descriptive only (measuring rule 2)

Each comparison below sets numbers from different runs side by side, so none of it is evidence. The within-run pairings
above are.

- **The candidates side by side** (`lc:`, top-1 / found@8 of 240, each against its own run's 公式 at 79 / 125):
  Qwen3-0.6B 110 / 148; Qwen3.5-0.8B 87 / 135; gemma-3-270m 70 / 119.
- **Beside the other judges on this seed** (digest `f661eb6a056e` throughout):

  | judge | top-1 / found@8 |
  |---|---|
  | Claude judge (Run 1 `content`) | 132 / 133 |
  | BGE (Runs 2, 4, 5, 5b) | 90–91 / 203–204 |
  | gemma-3-1b control `lc:` (Runs 3 and 5) | 33–36 / 111–113 |

- **Qwen3.5-0.8B read 85 / 138 in Run 5** (uncapped, no deadline, four chat models sharing one GPU) and **87 / 135
  here**. It is the same outcome under the rule, and not a paired comparison.
- **Qwen3-0.6B and gemma-3-270m had no outcome in Run 5.** Their partial Run 5 series leaned the same way their
  complete Run 5b series now read: Qwen3 ahead of 公式, the 270M behind on top-1.

### What it says

- **A local chat judge of 0.6B can beat having no judge, significantly, on both metrics.** Qwen3-0.6B is the first local
  CHAT judge measured here that does.
  - Launched as the product now launches it (thinking off, capped, with a deadline), it lifts top-1 from 79 to 110 and
    found@8 from 125 to 148.
  - It gains in every question set. On top-1 that is `same` 5/8, `cross` 0/9, `third` 1/13 and `mixed` 2/9. No set is
    significantly against it.
  - So the household's case, Chinese facts asked in Chinese or code-switched, is not paying for the cross-language
    gain. Qwen3.5-0.8B's `same` set leans the other way (top-1 14/5, −15.0pp, p = 0.064).
- **It complements BGE rather than replacing it, exactly as the Claude judge did in Runs 1–2.** It is better at
  putting the answer FIRST (top-1 +8.3pp against BGE) and much worse at putting it ON THE PAGE (found@8 −22.9pp). On
  this seed the Claude judge reads 132 / 133 and Qwen3-0.6B 110 / 148. The Claude judge costs ~9.5 s and account quota
  per recall; Qwen3-0.6B costs ~0.16 s warm and no quota.
- **Newer and multilingual is not enough on its own.** gemma-3-270m, the newest and smallest Gemma, makes recall
  measurably worse on top-1, like the 1B in Runs 3 and 5, though by less (−3.8pp against the 1B's −17.9 to −19.2pp).
  It is also the model the cap had to stop most often (64 of 494 replies).
- **A bigger model is not better here either.** Qwen3.5-0.8B, the larger and newer Qwen, is viable but shows no
  significant gain, where the older Qwen3-0.6B shows one on both metrics.

### What it does NOT say

- **One fixture of 60 invented facts, one run per candidate, one machine** (RTX 4080 Laptop, llama.cpp b10549, Vulkan).
  No chat-judge A/A twin ran. Run 5's control pair put the run-to-run wander of a sampling 1B judge at 25 discordant
  top-1 queries. Qwen3-0.6B's lead over 公式 is 31 net queries (8/39), inside a single run.
- **Recall only, over CLI-written subject tags.** A local chat judge also ANNOTATES every fact write. A household on
  Qwen3-0.6B would have tags Qwen3-0.6B wrote, and Lyntai measured small models drifting badly as annotators. That
  configuration is not measured here.
- **The deadline was not exercised.** No verification came near 60 s. The fix is shown not to regress anything; it is
  not shown working on a hung judge (that is `e2e-p52`'s job).
- **No embedder** (语义 off), **partition only**, **`EndorseCount`/page 8**, **≤ 60 candidates per recall**.
  Kind-filtered recalls of up to 400 candidates, where a 512-token cap could cut a legitimately long verdict, were not
  exercised.
- **Warm latency on one GPU with two models resident.** Cold loads and a busier GPU are not in it.
- **Thinking OFF.** Run 5's screen hinted that Qwen3 with thinking on reads the notes better, at 10–30× the latency.
  That is not measured.

**Evidence, local only** (gitignored). `devtools/_lc5b/<qwen3|gemma270m|qwen35>/` holds each run's bench output,
results file, router log, `presets.ini`, arm logs and `settings.json`, and its `guards.txt`. `devtools/_lc5b/driver.log`
is the sequence. The results files are also in `devtools/_judge-bench/`: `results-2026-09-24T053912.631Z.json`,
`…054422.547Z.json` and `…055101.569Z.json`.
