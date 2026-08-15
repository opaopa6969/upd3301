// mount — insert a .d88 the way `refdrv` does, so both emulators run the *same
// machine*.
//
// Companion to romset.mjs, and it exists for the same reason: every harness
// asymmetry found so far invalidated the comparison silently, and both were a
// line of mount code duplicated across a dozen tools rather than shared.
//
//   2026-08-13  refdrv called `Mount(0, …)` only, while the Node side had always
//               put image 1 into drive 1. 202 of the 353 files hold more than
//               one image, so on most of the collection the two emulators were
//               running different machines. Four titles spent five days recorded
//               as "M88 cannot boot them". (exact 328→332, tracking 333→341.)
//
//   2026-08-15  refdrv mounts every disk **read-only** —
//               `diskmgr.Mount(0, diskPath, /*readonly=*/true, 0, false)` —
//               which reaches the FDC as a real write-protect: FDU::WriteData
//               returns `ST0_AT | ST1_NW` (fdu.cpp:173) and SENSE DEVICE STATUS
//               reports 0x48 instead of 0x08. Our harness honoured the image's
//               own header flag instead, so a title that writes got a clean
//               termination from us and NW from M88. 森田のバトルフィールド alone
//               accounted for 624 of those, on a disk whose header says
//               "writable" — the difference was never in the image.
//
// The refdrv side cannot be the one to change: mounting writable would let M88
// write back into the user's 353-disk collection.
//
// So: this is the *only* place a comparison harness should mount a disk. If you
// find yourself writing `parseD88All(...).forEach(...)` in a tool, use this
// instead — a divergence hunt that mounts differently from the sweep is a
// divergence hunt against a machine the sweep never ran.

import { parseD88All } from '../d88.js';

/**
 * Mount a .d88 exactly as `refdrv` does: image 0 → drive 0, image 1 → drive 1,
 * both write-protected. Returns the parsed images.
 *
 * @param {object} m       a machine with `insertDisk(unit, img)`
 * @param {Uint8Array} bytes  the raw .d88 file
 * @param {object} [opts]
 * @param {boolean} [opts.writeProtect=true]  set false only for a tool that is
 *        deliberately testing writes; the parity harness must leave it on.
 * @param {number} [opts.drives=2]  how many images to insert
 */
export function mountD88(m, bytes, { writeProtect = true, drives = 2 } = {}) {
  const imgs = parseD88All(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  imgs.forEach((img, u) => {
    if (u >= drives) return;
    if (writeProtect) img.writeProtect = true;
    m.insertDisk(u, img);
  });
  return imgs;
}
