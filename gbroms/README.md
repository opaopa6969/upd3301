**English** · [日本語](./README.ja.md)

# gbroms — the test ROMs, and where each one came from

This directory is the reason issue #42 exists. Every other machine in this
repository needs a BIOS nobody may redistribute, so its tests skip in CI and
the verification is something the author did once on their own disk. The Game
Boy does not: its 256-byte boot ROM only scrolls the logo and then unmaps
itself, so **a cartridge is the whole machine**, and the console's test-ROM
culture produced a corpus that is genuinely free.

So the ones that may be redistributed are **committed here**, and CI actually
runs them. The ones that may not are **not here**, and the tests that use them
skip. Both halves are the point: a claim of "the CI runs real test ROMs" is
only worth anything if the boundary was checked file by file.

## Committed (licence permits redistribution)

| What | Files | Licence | Author |
|---|---|---|---|
| **dmg-acid2** | `dmg-acid2.gb.gz`, `dmg-acid2-reference.png` | MIT — `LICENSE-dmg-acid2` | Matt Currie |
| **mooneye-gb** | `mooneye/acceptance/**`, `mooneye/emulator-only/**` (103 files) | MIT — `mooneye/LICENSE` | Joonas Javanainen |

The ROMs are stored **gzipped**. Not to be clever: several of the MBC tests are
8MB of mostly padding, and gzip takes the whole corpus from 26MB to under
700KB — the difference between a fixture you can check in and one you cannot.
`gbtools/gbrun.mjs` reads `.gb` and `.gb.gz` alike, so an external ROM works
unchanged.

`dmg-acid2-reference.png` is the reference image from the dmg-acid2
repository, converted to 2-bit greyscale. Two bits is not a compromise: a DMG
has exactly four shades, and the PNG specification's own scaling of a 2-bit
sample to 8 bits gives `$00/$55/$AA/$FF` — the four values dmg-acid2's README
asks emulators to output. The comparison is therefore **exact, with no
tolerance anywhere**.

## Not committed (no licence)

**blargg's** suites (`cpu_instrs`, `instr_timing`, `mem_timing`,
`mem_timing-2`, `halt_bug`, `interrupt_time`, `oam_bug`, `dmg_sound`,
`cgb_sound`) are the best-known Game Boy test ROMs there are, and **neither the
ROMs nor their sources carry a licence or a public-domain dedication** — the
readme ends with an e-mail address and nothing else. Everybody mirrors them;
that is not a licence. So:

```sh
node gbtools/fetch-blargg.mjs          # → gbroms/blargg/ (git-ignored)
node gbtools/verify.mjs --blargg       # run them and print the score
```

`test-gb.mjs` skips its blargg test when the directory is absent, which is what
lets the suite pass on a clean clone.

## Running them

```sh
node --test test-gb.mjs                # the assertions (CI's regression net)
node gbtools/verify.mjs                # the same corpus, printed as a score
node gbtools/verify.mjs --blargg       # and blargg's too, if fetched
node gbtools/acid2.mjs                 # the picture, plus an ASCII thumbnail
node gbtools/suite.mjs gbroms/mooneye/acceptance --mooneye --model dmg
```

Current numbers and every known hole: `docs/gb-design.md` §10 and §11.
