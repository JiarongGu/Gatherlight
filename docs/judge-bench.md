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
  `mixed` question (120 queries): top-1 2/2, found@8 2/0. Six disagreements: four LAMAR's, two BGE's.
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
  LAMAR's; across all 120 Chinese-worded questions on 6, four LAMAR's and two BGE's; BGE's top-1 lead on `all`
  comes largely from English facts asked in English (10 vs 8 of 16). Latency is a wash (474 vs 489 ms serial,
  partition).
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
