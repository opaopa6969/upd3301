// romlabels — analyzed names and comments for ROM-internal routines.
//
// The ROMs themselves are NEC's (never shipped here — BYO-ROM), but the
// UNDERSTANDING of them is ours: every 'verified' entry below was walked
// instruction by instruction in this repo's boot investigations. This is
// the annotation layer an ICE label DB preloads, so the disassembly says
// send_byte_to_sub instead of 37C9h.
//
// Comments are bilingual {ja, en}; ja is the default display language.
// Addresses are ROM-version specific — each set names the dump it was
// verified against. Confidence follows memmap.js: verified / documented /
// approx.

export const SCHEMA_VERSION = 1;

const L = (addr, name, confidence, ja, en) =>
  Object.freeze({ addr, name, confidence, comment: Object.freeze({ ja, en }) });

export const ROM_LABELS = Object.freeze({
  // ---- PC-8801 N88 main ROM (verified against a mkII FR dump) -------------
  'n88-fr': Object.freeze({
    title: 'N88-BASIC ROM (PC-8801mkII FR)',
    note: {
      ja: 'アドレスはFR版実ダンプで検証。他版ではズレる可能性あり',
      en: 'Addresses verified against an FR dump; other ROM revisions may differ',
    },
    labels: Object.freeze([
      L(0x36db, 'check_boot_dipsw', 'verified',
        'IN 40h bit3で ROM起動/DISK起動 を判定（0=DISK）',
        'reads port 40h bit3: ROM vs DISK boot (0 = boot from disk)'),
      L(0x36e2, 'sub_ensure_init', 'verified',
        'サブシステム初期化＋ドライブ数取得（cmd 00→07）。戻り値A=台数',
        'init the disk sub-system and count drives (cmd 00→07); returns count in A'),
      L(0x3700, 'sub_init_and_count', 'verified',
        'cmd 00(初期化)送信→EF14=5→cmd 07でドライブマップ→上位ニブルのビット数を数える',
        'send cmd 00 (init), then cmd 07; counts set bits of the drive map high nibble'),
      L(0x3722, 'sub_send_rw_cmd', 'verified',
        'A=コマンドで呼ぶ。(EF4A)=unit,(EF5F)=track,B,Cをパラメータ送信',
        'call with A = command; sends (EF4A) unit, (EF5F) track, B, C as parameters'),
      L(0x373a, 'sub_recv_data', 'verified',
        'cmd 03（送信要求）→ Bページ×256バイトを(DE)へ受信。EF5D=2で密結合モード',
        'cmd 03 (send data) → receive B pages of 256 bytes into (DE); EF5D=2 selects the packed mode'),
      L(0x3766, 'sub_send_data', 'verified',
        '(DE)からサブへデータブロック送信（write系の相方）',
        'send a data block from (DE) to the sub (the write-side twin of 373A)'),
      L(0x3790, 'sub_check_result', 'verified',
        'cmd 06で結果ステータス取得。(res&41h)==01hで成功側の非局所脱出、それ以外はRET NZ',
        'cmd 06 result status; (res & 41h) == 01h takes a non-local success exit, else plain RET NZ'),
      L(0x37c9, 'sub_send_byte', 'verified',
        '8255経由で1バイト送信。ATN=C7セット→FE&6==2待ち→OUT FDh→ACK握手。BC×Dタイムアウト',
        'send one byte through the 8255: raise ATN (C7), wait FE&6==2, OUT FDh, ack dance; BC×D timeout'),
      L(0x3847, 'sub_recv_byte', 'verified',
        'サブから1バイト受信（FE bit0待ち→IN FCh）',
        'receive one byte from the sub (wait FE bit0, then IN FCh)'),
      L(0x382b, 'sub_hs_timeout', 'verified',
        'ハンドシェイクのタイムアウトカウンタ（C→B→D）。満了で(EF10)により脱出先分岐',
        'handshake timeout countdown (C→B→D); on expiry (EF10) picks the bail-out path'),
      L(0x3ab4, 'oscall_dispatch_3b', 'verified',
        'バンク間OSコール（インライン3バイト: addr lo/hi+バンク）。全レジスタ退避',
        'cross-bank OS call, 3 inline operand bytes (addr lo/hi + bank); saves full context'),
      L(0x3abe, 'oscall_dispatch_2b', 'verified',
        'バンク間OSコール（インライン2バイト版）。自コードのバイト列をオペランドとして二重利用する黒魔術入り',
        'cross-bank OS call, 2 inline bytes — includes the trick of reusing its own code bytes as operands'),
      L(0x3cc0, 'install_ram_hooks', 'verified',
        'ED00-EEFF帯に C3 xx xx フック群を敷設（テーブル3CFFから15本）',
        'installs the C3 xx xx RAM hooks in ED00-EEFF (15 entries from the table at 3CFF)'),
      L(0x3dbe, 'bank_restore_32_71', 'verified',
        'スタック上の(32h<<8|71h)値でバンク復元して戻るトランポリン',
        'trampoline restoring ports 32h/71h from a stacked word, then RET'),
      L(0x4551, 'veccall_enter', 'verified',
        'CALL 4551＋ベクタ番号バイト＝bank0ベクタ表(600D)へのテールコール。戻り先は呼び出し元の呼び出し元',
        'CALL 4551 + inline vector byte = tail-call via bank0 table at 600D; returns to the caller\'s caller'),
      L(0x4581, 'veccall_restore_a71', 'verified',
        'ベクタコールの復路（A/port 71h復元）',
        'vector-call return path (restores A and port 71h)'),
      L(0x6f06, 'boot_negotiate', 'verified',
        'ディスクブート: サブ機能ネゴ（ベクタ#1C=75A1をテールコール）',
        'disk boot: negotiate sub features (tail-calls vector #1C = 75A1)'),
      L(0x6f0a, 'boot_build_drivetab', 'verified',
        'ベクタ#1D=754Fをテールコール（ドライブ表構築）。458Fから呼ばれる',
        'tail-calls vector #1D = 754F (drive table build); invoked from 458F'),
      L(0x72cd, 'coldstart_block', 'verified',
        'コールドスタート本体: ポートシャドウ復元→サブinit→OPN init→IM 2→E4h←FF→画面init→EI',
        'cold start: restore port shadows, sub init, OPN init, IM 2, E4h←FF, screen init, EI'),
      L(0x754f, 'drivetab_build', 'verified',
        '(bank0) EF35/EF2D の存在表とサブ台数からEF64のインターフェース表とEC7D総数を構築',
        '(bank0) builds the EF64 interface table and EC7D total from EF35/EF2D presence tables + sub count'),
      L(0x75a1, 'sub_read_feature', 'verified',
        '(bank0) cmd 0BでサブROMの075Fを読み CPL&F0→EF63。非0なら cmd 17 0F（拡張モード）',
        '(bank0) cmd 0B reads sub ROM 075F, CPL&F0 → EF63; nonzero → cmd 17 0F (extended mode)'),
      L(0x780a, 'boot_stop_key_fork', 'verified',
        'IN 09h bit0（STOPキー）でブート経路分岐',
        'boot path fork on port 09h bit0 (the STOP key)'),
    ]),
  }),

  // ---- PC-80S31 sub-board ROM (2KB disk.rom, verified: mkII FR) ------------
  pc80s31: Object.freeze({
    title: 'PC-80S31 sub ROM (disk.rom 2KB)',
    note: {
      ja: 'FR同梱の2KB版で検証。コマンド表は011Bのジャンプテーブル',
      en: 'Verified on the FR 2KB image; command dispatch via the jump table at 011B',
    },
    labels: Object.freeze([
      L(0x00b1, 'poweron_pio_init', 'verified',
        '8255をモード91h（A入力/B出力/CH出力/CL入力）に設定',
        'programs the 8255 to mode 91h (A in / B out / C-hi out / C-lo in)'),
      L(0x00cc, 'idle_poll_loop', 'verified',
        'コマンド待ちループ: IN FEh bit3（メインのATN）をポーリング。タイムアウトでモーターOFF',
        'command wait loop polling FE bit3 (main\'s ATN); motors off on timeout'),
      L(0x00ec, 'cmd_dispatch', 'verified',
        '受信コマンド(<1Fh)を011Bのジャンプテーブルへ。初回はモーターON＋安定待ち',
        'dispatches a received command (<1Fh) via the table at 011B; first use spins motors up'),
      L(0x011b, 'cmd_jump_table', 'verified',
        '00=init 01=write 02=read 03=send 05=format 06=result(7F14) 07=drivemap(7F15) 0B=mem→main 0C=main→mem 17=modeflags 1B=リモート実行',
        '00 init, 01 write, 02 read, 03 send, 05 format, 06 result (7F14), 07 drive map (7F15), 0B mem→main, 0C main→mem, 17 mode flags, 1B remote execute'),
      L(0x015d, 'cmd00_initialize', 'verified',
        'SPECIFY→全ドライブをRECAL+SEEK(10)+RECALでプローブ→7F15にドライブマップ（キャリーをRRAで詰める）',
        'SPECIFY, then probe each drive (RECAL + SEEK 10 + RECAL); packs the drive map into 7F15 via RRA'),
      L(0x02a4, 'fdc_send_cmd', 'verified',
        'μPD765へコマンドバイト送信（MSRのRQM/DIO待ち→OUT FBh）。7F0Cに記録',
        'send a command byte to the μPD765 (wait RQM/DIO in MSR, OUT FBh); logs to 7F0C'),
      L(0x02b4, 'motor_settle_delay', 'verified',
        'モーター安定待ち: 65536×2重ループ≒0.85秒×2回。7F09フラグで2回目以降スキップ',
        'motor settle delay: double 65536 loop ≈ 0.85s, twice; the 7F09 flag skips it once spun up'),
      L(0x05bc, 'cmd17_mode_flags', 'verified',
        '1バイト受信→下位4bitを7F1C-7F1Fのドライブ別フラグに展開（拡張モード）',
        'receive one byte; expand low 4 bits into per-drive flags at 7F1C-1F (extended mode)'),
      L(0x05da, 'cmd1b_remote_exec', 'verified',
        'リモート実行: LD I→SP切替(7F2E)→全レジスタPOP→JP 7F25。メインが送ったコードをサブZ80で走らせる公式機構',
        'remote execute: LD I, switch SP to 7F2E, pop full register set, JP 7F25 — official main-supplied-code execution'),
      L(0x06a6, 'recv_params_bcde', 'verified',
        'パラメータ4バイト受信（B,C,D,Eの順）',
        'receive 4 parameter bytes into B, C, D, E'),
      L(0x070f, 'send_byte_to_main', 'verified',
        '8255経由でメインへ1バイト送信（RST 18hの実体）',
        'send one byte to the main CPU through the 8255 (the body of RST 18h)'),
    ]),
  }),
});

// flatten to {addr → entry} for a given ROM set
export function labelMap(setName) {
  const set = ROM_LABELS[setName];
  if (!set) return new Map();
  return new Map(set.labels.map((l) => [l.addr, l]));
}

// comment in the requested language (ja is the house default)
export function commentFor(entry, lang = 'ja') {
  return entry?.comment?.[lang] ?? entry?.comment?.ja ?? '';
}
