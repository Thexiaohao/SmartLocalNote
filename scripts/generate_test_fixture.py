"""Generate the compact V6 All-Format Test-Flow Fixture Pack into `assets/demo_seed/`.

Usage:
    python scripts/generate_test_fixture.py
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
import struct
import wave
from xml.sax.saxutils import escape as xml_escape
import zipfile
import zlib

ROOT_DIR = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT_DIR / "assets" / "demo_seed"


# ---------------------------------------------------------------------------
# 1. Pure-Python PNG generator (480x260 clean architecture diagram card)
# ---------------------------------------------------------------------------

def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)


def _make_png_bytes(width: int, height: int, *, variant: int = 0) -> bytes:
    """Create a crisp RGBA/RGB PNG diagram card using pure Python zlib + struct."""
    raw_rows = bytearray()

    def _fill_rect(buf: bytearray, x0: int, y0: int, x1: int, y1: int, rgb: tuple[int, int, int]) -> None:
        r, g, b = rgb
        cx0, cx1 = max(0, x0), min(width, x1)
        cy0, cy1 = max(0, y0), min(height, y1)
        for y in range(cy0, cy1):
            base = y * (width * 3 + 1) + 1
            for x in range(cx0, cx1):
                idx = base + x * 3
                buf[idx] = r
                buf[idx + 1] = g
                buf[idx + 2] = b

    for y in range(height):
        raw_rows.append(0)  # filter type 0
        t = y / max(1, height - 1)
        if variant == 0:
            bg_r = int(244 - t * 14)
            bg_g = int(247 - t * 10)
            bg_b = int(252 - t * 6)
        else:
            bg_r = int(238 + t * 10)
            bg_g = int(248 - t * 12)
            bg_b = int(244 - t * 6)
        raw_rows.extend(bytes((bg_r, bg_g, bg_b)) * width)

    if width >= 300 and height >= 160:
        # Top accent bar
        _fill_rect(raw_rows, 0, 0, width, 10, (37, 99, 235))
        # Left pane card (Navigation)
        _fill_rect(raw_rows, 22, 32, 130, height - 26, (255, 255, 255))
        _fill_rect(raw_rows, 22, 32, 130, 56, (59, 130, 246))
        for i in range(4):
            yy = 72 + i * 28
            _fill_rect(raw_rows, 34, yy, 118, yy + 14, (226, 232, 240))
        # Center pane card (Editor + Multi-format Preview)
        _fill_rect(raw_rows, 148, 32, 332, height - 26, (255, 255, 255))
        _fill_rect(raw_rows, 148, 32, 332, 56, (16, 185, 129))
        _fill_rect(raw_rows, 162, 74, 318, 120, (236, 253, 245))
        _fill_rect(raw_rows, 162, 134, 246, 178, (219, 234, 254))
        _fill_rect(raw_rows, 254, 134, 318, 178, (254, 243, 199))
        _fill_rect(raw_rows, 162, 190, 318, height - 42, (241, 245, 249))
        # Right pane card (AI + Focus Island)
        _fill_rect(raw_rows, 350, 32, width - 22, height - 26, (255, 255, 255))
        _fill_rect(raw_rows, 350, 32, width - 22, 56, (139, 92, 246))
        _fill_rect(raw_rows, 362, 74, width - 34, 138, (245, 243, 255))
        _fill_rect(raw_rows, 362, 152, width - 34, height - 42, (248, 250, 252))
        # Connector lines
        _fill_rect(raw_rows, 130, 110, 148, 114, (59, 130, 246))
        _fill_rect(raw_rows, 332, 110, 350, 114, (139, 92, 246))
    else:
        _fill_rect(raw_rows, 6, 6, width - 6, height - 6, (59, 130, 246))
        _fill_rect(raw_rows, 14, 14, width - 14, height - 14, (236, 253, 245))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=9)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


# ---------------------------------------------------------------------------
# 2. Pure-Python WAV chime generator (1.5s stereo/mono 16-bit PCM)
# ---------------------------------------------------------------------------

def _make_wav_bytes(duration_sec: float = 1.5, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    total_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(total_frames):
            t = i / sample_rate
            if t < 0.75:
                freq = 523.25  # C5
                local_t = t
            else:
                freq = 659.25  # E5
                local_t = t - 0.75
            attack = min(1.0, local_t / 0.03)
            decay = math.exp(-local_t * 4.2)
            sample = 0.38 * attack * decay * (
                0.75 * math.sin(2.0 * math.pi * freq * t)
                + 0.25 * math.sin(2.0 * math.pi * (freq * 2.0) * t)
            )
            pcm = max(-32767, min(32767, int(sample * 32767)))
            frames.extend(struct.pack("<h", pcm))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 3. Pure-Python valid H.264 Baseline MP4 generator (2.0s @ 10fps, 64x64)
# ---------------------------------------------------------------------------

class _BitWriter:
    def __init__(self) -> None:
        self.bits: list[int] = []

    def write_bit(self, b: int) -> None:
        self.bits.append(1 if b else 0)

    def write_bits(self, val: int, n: int) -> None:
        for shift in range(n - 1, -1, -1):
            self.bits.append((val >> shift) & 1)

    def write_ue(self, val: int) -> None:
        code_num = val + 1
        bit_len = code_num.bit_length()
        for _ in range(bit_len - 1):
            self.bits.append(0)
        self.write_bits(code_num, bit_len)

    def write_se(self, val: int) -> None:
        if val <= 0:
            self.write_ue(-2 * val)
        else:
            self.write_ue(2 * val - 1)

    def align_zero(self) -> None:
        while len(self.bits) % 8 != 0:
            self.bits.append(0)

    def write_rbsp_trailing(self) -> None:
        self.write_bit(1)
        self.align_zero()

    def to_bytes(self) -> bytes:
        padded = list(self.bits)
        while len(padded) % 8 != 0:
            padded.append(0)
        out = bytearray()
        for i in range(0, len(padded), 8):
            byte_val = 0
            for b in padded[i : i + 8]:
                byte_val = (byte_val << 1) | b
            out.append(byte_val)
        return bytes(out)


def _rbsp_to_ebsp(nal_header: int, rbsp: bytes) -> bytes:
    """Escape 0x000000..0x000003 sequences per H.264 Annex B / AVCC RBSP->EBSP rules."""
    out = bytearray([nal_header])
    zeros = 0
    for b in rbsp:
        if zeros >= 2 and b <= 3:
            out.append(0x03)
            zeros = 0
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


def _build_h264_sps(mb_w: int = 4, mb_h: int = 4) -> bytes:
    bw = _BitWriter()
    bw.write_bits(66, 8)     # profile_idc = Baseline
    bw.write_bits(0xC0, 8)   # constraint_set0_flag=1, constraint_set1_flag=1
    bw.write_bits(30, 8)     # level_idc = 3.0
    bw.write_ue(0)           # seq_parameter_set_id
    bw.write_ue(0)           # log2_max_frame_num_minus4 -> 4 bits
    bw.write_ue(2)           # pic_order_cnt_type = 2
    bw.write_ue(1)           # max_num_ref_frames = 1
    bw.write_bit(0)          # gaps_in_frame_num_value_allowed_flag
    bw.write_ue(mb_w - 1)    # pic_width_in_mbs_minus1
    bw.write_ue(mb_h - 1)    # pic_height_in_map_units_minus1
    bw.write_bit(1)          # frame_mbs_only_flag
    bw.write_bit(0)          # direct_8x8_inference_flag
    bw.write_bit(0)          # frame_cropping_flag
    bw.write_bit(0)          # vui_parameters_present_flag
    bw.write_rbsp_trailing()
    return _rbsp_to_ebsp(0x67, bw.to_bytes())


def _build_h264_pps() -> bytes:
    bw = _BitWriter()
    bw.write_ue(0)           # pic_parameter_set_id
    bw.write_ue(0)           # seq_parameter_set_id
    bw.write_bit(0)          # entropy_coding_mode_flag = CAVLC
    bw.write_bit(0)          # bottom_field_pic_order_in_frame_present_flag
    bw.write_ue(0)           # num_slice_groups_minus1
    bw.write_ue(0)           # num_ref_idx_l0_default_active_minus1
    bw.write_ue(0)           # num_ref_idx_l1_default_active_minus1
    bw.write_bit(0)          # weighted_pred_flag
    bw.write_bits(0, 2)      # weighted_bipred_idc
    bw.write_se(0)           # pic_init_qp_minus26
    bw.write_se(0)           # pic_init_qs_minus26
    bw.write_se(0)           # chroma_qp_index_offset
    bw.write_bit(0)          # deblocking_filter_control_present_flag
    bw.write_bit(0)          # constrained_intra_pred_flag
    bw.write_bit(0)          # redundant_pic_cnt_present_flag
    bw.write_rbsp_trailing()
    return _rbsp_to_ebsp(0x68, bw.to_bytes())


def _build_h264_idr_ipcm(
    mb_w: int,
    mb_h: int,
    idr_pic_id: int,
    yuv_blocks: list[tuple[int, int, int]],
) -> bytes:
    bw = _BitWriter()
    bw.write_ue(0)            # first_mb_in_slice
    bw.write_ue(7)            # slice_type = I (all-I)
    bw.write_ue(0)            # pic_parameter_set_id
    bw.write_bits(0, 4)       # frame_num = 0
    bw.write_ue(idr_pic_id)   # idr_pic_id
    bw.write_bit(0)           # no_output_of_prior_pics_flag
    bw.write_bit(0)           # long_term_reference_flag
    bw.write_se(0)            # slice_qp_delta

    total_mbs = mb_w * mb_h
    for idx in range(total_mbs):
        y_val, cb_val, cr_val = yuv_blocks[idx]
        bw.write_ue(25)       # mb_type = I_PCM
        bw.align_zero()       # pcm_alignment_zero_bit
        for _ in range(256):
            bw.write_bits(y_val, 8)
        for _ in range(64):
            bw.write_bits(cb_val, 8)
        for _ in range(64):
            bw.write_bits(cr_val, 8)

    bw.write_rbsp_trailing()
    return _rbsp_to_ebsp(0x65, bw.to_bytes())


def _build_h264_p_skip(mb_w: int, mb_h: int, frame_num: int) -> bytes:
    bw = _BitWriter()
    bw.write_ue(0)                # first_mb_in_slice
    bw.write_ue(5)                # slice_type = P (all-P)
    bw.write_ue(0)                # pic_parameter_set_id
    bw.write_bits(frame_num & 0xF, 4)
    bw.write_bit(0)               # num_ref_idx_active_override_flag
    bw.write_bit(0)               # ref_pic_list_modification_flag_l0
    bw.write_bit(0)               # adaptive_ref_pic_marking_mode_flag
    bw.write_se(0)                # slice_qp_delta
    bw.write_ue(mb_w * mb_h)      # mb_skip_run = all MBs skipped
    bw.write_rbsp_trailing()
    return _rbsp_to_ebsp(0x41, bw.to_bytes())


def _mp4_box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def _mp4_full_box(box_type: bytes, version: int, flags: int, payload: bytes) -> bytes:
    header = struct.pack(">I", ((version & 0xFF) << 24) | (flags & 0xFFFFFF))
    return _mp4_box(box_type, header + payload)


def _make_mp4_bytes() -> bytes:
    """Build a valid 2.0-second 64x64 H.264 Baseline MP4 video (~13KB) in pure Python."""
    mb_w, mb_h = 4, 4
    width, height = mb_w * 16, mb_h * 16
    sps = _build_h264_sps(mb_w, mb_h)
    pps = _build_h264_pps()

    # Scene 1 (t=0..1s): crisp cobalt-blue card with bright center square
    scene1: list[tuple[int, int, int]] = []
    # Scene 2 (t=1..2s): warm emerald-teal card with gold center square
    scene2: list[tuple[int, int, int]] = []
    for my in range(mb_h):
        for mx in range(mb_w):
            is_center = (1 <= mx <= 2) and (1 <= my <= 2)
            scene1.append((210, 110, 140) if is_center else (95, 175, 95))
            scene2.append((200, 90, 155) if is_center else (120, 130, 90))

    raw_nals: list[bytes] = []
    # 20 frames @ 10 fps -> 2.0 seconds total; sync frames at index 0 (frame 1) and 10 (frame 11)
    raw_nals.append(_build_h264_idr_ipcm(mb_w, mb_h, 0, scene1))
    for fn in range(1, 10):
        raw_nals.append(_build_h264_p_skip(mb_w, mb_h, fn))
    raw_nals.append(_build_h264_idr_ipcm(mb_w, mb_h, 1, scene2))
    for fn in range(1, 10):
        raw_nals.append(_build_h264_p_skip(mb_w, mb_h, fn))

    samples = [struct.pack(">I", len(nal)) + nal for nal in raw_nals]
    mdat_payload = b"".join(samples)

    timescale = 1000
    sample_delta = 100  # 100ms per frame -> 10fps -> 2000ms total
    total_duration = len(samples) * sample_delta
    identity_matrix = struct.pack(">9I", 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)

    ftyp = _mp4_box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2avc1mp41")

    mvhd = _mp4_full_box(
        b"mvhd", 0, 0,
        struct.pack(">4I", 0, 0, timescale, total_duration)
        + struct.pack(">I", 0x00010000)  # rate 1.0
        + struct.pack(">H", 0x0100)      # volume 1.0
        + b"\x00" * 10
        + identity_matrix
        + b"\x00" * 24
        + struct.pack(">I", 2),          # next_track_id
    )

    tkhd = _mp4_full_box(
        b"tkhd", 0, 0x000003,
        struct.pack(">5I", 0, 0, 1, 0, total_duration)
        + b"\x00" * 8
        + struct.pack(">4H", 0, 0, 0, 0)
        + identity_matrix
        + struct.pack(">2I", width << 16, height << 16),
    )

    mdhd = _mp4_full_box(
        b"mdhd", 0, 0,
        struct.pack(">4I2H", 0, 0, timescale, total_duration, 0x55C4, 0),
    )
    hdlr = _mp4_full_box(
        b"hdlr", 0, 0,
        struct.pack(">I", 0) + b"vide" + b"\x00" * 12 + b"VideoHandler\x00",
    )
    vmhd = _mp4_full_box(b"vmhd", 0, 1, struct.pack(">4H", 0, 0, 0, 0))
    url_box = _mp4_full_box(b"url ", 0, 1, b"")
    dref = _mp4_full_box(b"dref", 0, 0, struct.pack(">I", 1) + url_box)
    dinf = _mp4_box(b"dinf", dref)

    avcc = _mp4_box(
        b"avcC",
        struct.pack(">6B", 1, sps[1], sps[2], sps[3], 0xFF, 0xE1)
        + struct.pack(">H", len(sps)) + sps
        + struct.pack(">B", 1)
        + struct.pack(">H", len(pps)) + pps,
    )
    avc1_body = (
        b"\x00" * 6
        + struct.pack(">H", 1)
        + b"\x00" * 16
        + struct.pack(">2H", width, height)
        + struct.pack(">2I", 0x00480000, 0x00480000)
        + struct.pack(">I", 0)
        + struct.pack(">H", 1)
        + b"\x00" * 32
        + struct.pack(">Hh", 0x0018, -1)
        + avcc
    )
    avc1 = _mp4_box(b"avc1", avc1_body)
    stsd = _mp4_full_box(b"stsd", 0, 0, struct.pack(">I", 1) + avc1)
    stts = _mp4_full_box(b"stts", 0, 0, struct.pack(">3I", 1, len(samples), sample_delta))
    stsc = _mp4_full_box(b"stsc", 0, 0, struct.pack(">4I", 1, 1, len(samples), 1))
    stsz = _mp4_full_box(
        b"stsz", 0, 0,
        struct.pack(">2I", 0, len(samples)) + b"".join(struct.pack(">I", len(s)) for s in samples),
    )
    stss = _mp4_full_box(b"stss", 0, 0, struct.pack(">3I", 2, 1, 11))

    # Build stco with placeholder offset, then patch exact mdat payload offset
    stco_placeholder = _mp4_full_box(b"stco", 0, 0, struct.pack(">2I", 1, 0))
    stbl_dummy = _mp4_box(b"stbl", stsd + stts + stsc + stsz + stss + stco_placeholder)
    minf_dummy = _mp4_box(b"minf", vmhd + dinf + stbl_dummy)
    mdia_dummy = _mp4_box(b"mdia", mdhd + hdlr + minf_dummy)
    trak_dummy = _mp4_box(b"trak", tkhd + mdia_dummy)
    moov_dummy = _mp4_box(b"moov", mvhd + trak_dummy)

    mdat_data_offset = len(ftyp) + len(moov_dummy) + 8
    stco = _mp4_full_box(b"stco", 0, 0, struct.pack(">2I", 1, mdat_data_offset))
    stbl = _mp4_box(b"stbl", stsd + stts + stsc + stsz + stss + stco)
    minf = _mp4_box(b"minf", vmhd + dinf + stbl)
    mdia = _mp4_box(b"mdia", mdhd + hdlr + minf)
    trak = _mp4_box(b"trak", tkhd + mdia)
    moov = _mp4_box(b"moov", mvhd + trak)
    mdat = _mp4_box(b"mdat", mdat_payload)

    return ftyp + moov + mdat


# ---------------------------------------------------------------------------
# 4. Valid Office Open XML (.docx & .pptx) builders
# ---------------------------------------------------------------------------

def _make_docx_bytes() -> bytes:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        '</Relationships>'
    )
    paragraphs = [
        "SmartLocalNote V6 接口契约文档",
        "1. 文档读取与内联展开接口",
        "GET /api/files/read?path=... 返回文档元信息、文本正文或伴生笔记路径。",
        "GET /api/files/expand-content?path=...&page=...&sheet=...&cell=...&member=... "
        "在本地安全白名单内将文本、表格、PDF 文字层、Office 与压缩包单文件转换为 Markdown 供一键填入笔记。",
        "2. 测试工作台重置接口",
        "POST /api/system/seed-test-suite?reset=true 一键同步并重置 V6_实测流程 文件夹内的标准全格式实测包，不覆盖用户其它笔记。",
        "3. 伴生笔记防冲突规则",
        "PDF 保持 <stem>_伴生笔记.md 向后兼容；DOCX/PPTX/图片/音视频默认采用 <stem>_<ext>_伴生笔记.md，避免同名前缀文件相互覆盖。",
    ]
    p_xml = "".join(
        f"<w:p><w:r><w:t>{xml_escape(text)}</w:t></w:r></w:p>"
        for text in paragraphs
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{p_xml}<w:sectPr/></w:body>"
        "</w:document>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types.encode("utf-8"))
        zf.writestr("_rels/.rels", rels.encode("utf-8"))
        zf.writestr("word/document.xml", document_xml.encode("utf-8"))
    return buf.getvalue()


def _make_pptx_bytes() -> bytes:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slides/slide1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '<Override PartName="/ppt/slides/slide2.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="ppt/presentation.xml"/>'
        '</Relationships>'
    )
    pres_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
        '</Relationships>'
    )
    presentation_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:sldIdLst>'
        '<p:sldId id="256" r:id="rId1"/>'
        '<p:sldId id="257" r:id="rId2"/>'
        '</p:sldIdLst>'
        '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>'
        '</p:presentation>'
    )

    def _slide_xml(title: str, bullets: list[str]) -> str:
        lines = [title, *bullets]
        p_nodes = "".join(
            f"<a:p><a:r><a:t>{xml_escape(line)}</a:t></a:r></a:p>"
            for line in lines
        )
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:cSld><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr/>'
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{p_nodes}</p:txBody></p:sp>'
            '</p:spTree></p:cSld></p:sld>'
        )

    slide1 = _slide_xml(
        "SmartLocalNote V6 评审幻灯片 · 第 1 页",
        [
            "本地优先：Zero-Build ES6 模块 + FastAPI 安全文件网关",
            "全格式直达：MD / TXT / PY / JSON / XLSX / PDF / DOCX / PPTX / ZIP / 音视频",
        ],
    )
    slide2 = _slide_xml(
        "第 2 页：V6 核心升级验收点",
        [
            "1. 所见即所得 WYSIWYG + Word 图标格式栏 + / 斜杠指令菜单",
            "2. 灵动岛 NotchDrop 下拉暂存抽屉 & 0.5 秒长按剪切重排",
            "3. 悬停速览 400ms + Ctrl+点击双栏分屏 + 禅模式 (Ctrl+\\)",
        ],
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types.encode("utf-8"))
        zf.writestr("_rels/.rels", rels.encode("utf-8"))
        zf.writestr("ppt/presentation.xml", presentation_xml.encode("utf-8"))
        zf.writestr("ppt/_rels/presentation.xml.rels", pres_rels.encode("utf-8"))
        zf.writestr("ppt/slides/slide1.xml", slide1.encode("utf-8"))
        zf.writestr("ppt/slides/slide2.xml", slide2.encode("utf-8"))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 5. XLSX & PDF builders
# ---------------------------------------------------------------------------

def _make_xlsx_bytes() -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws1 = wb.active
    ws1.title = "任务进度"
    ws1.append(["模块", "任务项", "负责人", "状态", "进度", "耗时(分钟)", "备注"])
    ws1.append(["核心引擎", "路径安全网关与快照回滚", "Backend", "已完成", "100%", 45, "safe_io 校验通过"])
    ws1.append(["编辑器", "WYSIWYG 零语法编辑与 Word 图标格式栏", "Frontend", "已完成", "100%", 40, "支持 / 斜杠菜单与胶囊内联"])
    ws1.append(["灵动岛", "NotchDrop 下拉暂存抽屉 & 后台 AI 胶囊", "Frontend", "测试中", "95%", 35, "0.5s 长按剪切拖块"])
    ws1.append(["闪念卡", "V6 顶部彩条、自定义色盘、叠放联动与合并撤销", "Frontend", "待验收", "90%", 30, "自适应高度与↗拆出"])
    ws1.append(["交互创新", "Hover Peek / Ctrl+Click 分屏 / 前进后退 / 禅模式", "Fullstack", "待验收", "90%", 25, "目标表 05_迭代进度表.xlsx"])

    ws2 = wb.create_sheet("验收记录")
    ws2.append(["日期", "测试项", "结果", "记录人"])
    ws2.append(["2026-11-20", "全格式双括号跳转与 Ctrl+Click 分屏", "待执行", "QA"])
    ws2.append(["2026-11-20", "PDF 默认原生预览与第2页直达展开", "待执行", "QA"])
    ws2.append(["2026-11-20", "ZIP 压缩包内单文件读取与暂存抽屉", "待执行", "QA"])

    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


def _make_pdf_bytes() -> bytes:
    import pymupdf

    doc = pymupdf.open()
    pages_content = [
        (
            "SmartLocalNote V6 产品方案简报 (第 1 页)",
            [
                "定位：纯本地、零构建、多格式一体化的个人知识工作台。",
                "核心理念：",
                "  1. 所有读写严格经过 safe_io.py 路径白名单与 .bak 快照保护。",
                "  2. 双括号传送门 [[文件名#锚点]] 支持悬停速览与 Ctrl+Click 分屏。",
                "  3. PDF 默认优先原生预览，同时配备右侧独立伴生笔记。",
                "提示：请尝试跳转到本文件第 2 页 [[06_产品方案简报.pdf#page=2]] 测试页码直达与展开。",
            ],
        ),
        (
            "V6 核心亮点与实测要点 (第 2 页)",
            [
                "1. 所见即所得 WYSIWYG + Word 图标栏 + / 斜杠指令菜单：",
                "   选中链接 [[06_产品方案简报.pdf#page=2]] 可直接抽取本页文字并插入笔记。",
                "2. 灵动岛 NotchDrop 下拉暂存抽屉与 0.5 秒长按拖块：",
                "   默认以剪切移动模式重排段落，拖入顶栏灵动岛即可跨文件暂存。",
                "3. 伴生笔记防冲突：",
                "   同前缀的 .pdf 与 .docx 自动映射到独立的伴生笔记文件，互不覆盖。",
            ],
        ),
        (
            "扩展规划与验收总结 (第 3 页)",
            [
                "1. 非阻塞后台 AI：AI 总结与问答可在灵动岛胶囊后台运行，切换文档不中断。",
                "2. 灵动岛专注计时：计时结束可将任务耗时与备注一键写回 Excel 进度表。",
                "3. 纯本地可移植：所有数据保存在 data/ 目录，支持一键重新生成 V6 实测流程包。",
            ],
        ),
    ]

    for idx, (title, lines) in enumerate(pages_content, start=1):
        page = doc.new_page(width=595, height=842)
        # Top colored banner
        page.draw_rect(pymupdf.Rect(0, 0, 595, 72), color=(0.15, 0.39, 0.92), fill=(0.15, 0.39, 0.92))
        page.insert_text((44, 46), title, fontname="china-s", fontsize=18, color=(1, 1, 1))
        y = 120
        for line in lines:
            page.insert_text((48, y), line, fontname="china-s", fontsize=12, color=(0.12, 0.16, 0.22))
            y += 30
        page.insert_text((48, 790), f"SmartLocalNote V6 Test Fixture - Page {idx} / 3", fontname="helv", fontsize=9, color=(0.45, 0.5, 0.58))

    return doc.tobytes()


# ---------------------------------------------------------------------------
# 6. Text & Archive fixtures
# ---------------------------------------------------------------------------

def _checklist_md() -> str:
    return """# 00 · SmartLocalNote V6 全流程实测清单

欢迎使用 **V6 全格式实测流程包**！按以下步骤逐项体验并勾选 `[ ]`，即可完成 V6 全部核心升级、交互创新与 13 种格式端到端验收。

---

## 步骤 1：WYSIWYG 零语法编辑 · Word 图标格式栏 · `/` 斜杠菜单

- [ ] **所见即所得直接编辑**：点击任意段落直接输入或修改文字，无需看到 `**` / `#` / `>` 等原始 Markdown 符号
- [ ] **顶部 Word 图标格式栏**：选中文字后点击顶部 32px 紧凑图标栏（加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 标题 / 列表 / 引用 / 代码 / 任务 / 表格 / 撤销重做）
- [ ] **`/` 斜杠指令菜单**：在段落开头或新行输入 `/` 唤醒指令菜单，用方向键或鼠标插入标题、待办、代码块、引用、分隔线或文件传送门

---

## 步骤 2：默认剪切拖拽 · 0.5 秒长按拖块 · 灵动岛 NotchDrop 暂存抽屉

> 在当前编辑器中按住任意段落块 **0.5 秒（500ms）** 即可长按拖起：同文档内默认执行 **剪切移动**，拖至目标块下方会显示 **蓝色插入线**；拖入顶部 **灵动岛 NotchDrop 暂存抽屉** 即可跨文件收集与批量插入！

- **[可拖拽测试块 A]** V6 剪切拖块实测段落 A：长按 0.5 秒拖动到测试块 B 下方（观察蓝色插入线），确认原位移除并插入新位置。
- **[可拖拽测试块 B]** V6 灵动岛暂存测试段落 B：长按拖至顶栏灵动岛触发下拉暂存抽屉，再切换到 `[[01_项目需求拆解.md]]` 点击「插入」或拖回。
- **[左树拖入文件]** 从左侧文件树直接拖入任意文件到编辑区，自动生成带坐标的 `[[...]]` 双括号传送门胶囊。

---

## 步骤 3：Hover Peek 悬停速览 · `Ctrl+Click` 分屏阅读 · 前进后退 · 禅模式

- [ ] **Hover Peek 悬停速览（400ms）**：将鼠标悬停在 `[[01_项目需求拆解.md#Chapter1 架构设计]]` 胶囊上停留 400ms，观察浮现的玻璃预览卡及「直达 / 分屏」快捷按钮
- [ ] **`Ctrl+Click` 双栏分屏阅读**：按住 `Ctrl` 并点击 [[01_项目需求拆解.md]] 或 [[05_迭代进度表.xlsx#任务进度!B3]]，在中间栏右侧开启 50/50 独立滚动分屏对照视图
- [ ] **前进 / 后退导航**：点击中间栏顶部的 `←` / `→` 历史按钮（或按 `Alt+←` / `Alt+→`），验证跨文件与分屏历史栈回溯
- [ ] **极简专注禅模式**：点击顶栏右侧展开图标或按 `Ctrl+\\` 切换禅模式，隐藏左右边栏并居中文档工作区

---

## 步骤 4：Markdown 跨文件锚点与右键「一键展开内容填入」

请在编辑区右键以下传送门胶囊，选择 **「一键展开内容填入」**，或点击验证跨文件跳转：

- [ ] **普通跨文件章节跳转**：[[01_项目需求拆解.md#Chapter1 架构设计]]
- [ ] **下划线边界标题跳转**（验证 `_` 不被误解析为斜体）：[[01_项目需求拆解.md#_下划线_边界测试]]
- [ ] **无后缀文件直达**：[[01_项目需求拆解]]
- [ ] **同文件内锚点跳转**：[[#步骤 9：全格式直达验收（13 种格式）]]
- [ ] **标准 Markdown 相对链接**：[标准MD链接测试](01_项目需求拆解.md)
- [ ] **Python 源码展开**（自动包裹代码块）：[[03_核心脚本示例.py]]
- [ ] **Excel 指定单元格窗口展开**：[[05_迭代进度表.xlsx#任务进度!B3]]
- [ ] **PDF 指定页码展开**：[[06_产品方案简报.pdf#page=2]]
- [ ] **Word 文档展开**：[[07_接口文档.docx]]
- [ ] **压缩包内单文本文件展开**：[[09_发布资源包.zip!README.txt]]
- [ ] **拦截提示测试（音频应提示不支持）**：[[11_提示音样本.wav]]
- [ ] **拦截提示测试（压缩包整体应提示定位到具体文本成员）**：[[09_发布资源包.zip]]

---

## 步骤 5：闪念卡 V6 实测指引

- [ ] 在工作台空白处或编辑器 **右键召唤闪念卡**
- [ ] 验证全新 **高对比度卡片主体 + 顶部彩条**，点击颜色块打开 **右侧对齐色盘 + 自定义取色器**（不裁切、不发灰）
- [ ] 点击 **📌 钉子固定** 后再尝试拖动，验证仅钉子图标抖动且卡片脉冲提示（卡片本身不位移错乱）
- [ ] 拖入多张卡片进行 **叠放合并**，测试 **整叠一起拖动**、顶部 **`↗` 拆出单卡**、底部 **撤销合并按钮** 与 **自适应卡片尺寸**

---

## 步骤 6：左侧文件树 · 置顶 · 混合排序 · 行内重命名与新建

- [ ] 验证排序按钮右下角 **语义角标小图标**（已移除旧版小蓝点），打开排序菜单测试 **`🧹 一键整理`**
- [ ] 对重要文件右键 **置顶（📌）**，测试 **置顶文件与自定义拖拽排序（上下蓝色插入线）**
- [ ] 选中文件按 `F2` / 双击 / 右键重命名，验证 **行内输入框直接改名** 与顶部 **行内快捷新建**
- [ ] 对左侧或右侧模块标题栏 **右键** 打开 **模块级布局记忆与预设菜单**（折叠 / 高度 / 恢复默认布局）

---

## 步骤 7：未保存修改弹窗与非阻塞后台 AI

- [ ] 在本笔记任意位置输入几个字符（保持未保存状态），然后点击左侧其他文件，验证紧凑 **「💾 保存并退出 / 放弃修改 / 取消」** 弹窗（无异常拉伸）
- [ ] 在右侧勾选多份文件触发 **AI 总结或联合问答**，切换到其他文档时观察顶栏 **灵动岛后台 AI 运行胶囊**，完成后点击 `[查看结果]` 直达

---

## 步骤 8：媒体内联显示与右下角缩放

以下媒体胶囊支持直接在编辑/阅读视图内联渲染，可拖动媒体右下角手柄调整显示宽度：

[[10_架构示意.png|w=360]]

[[12_短片演示.mp4#t=00:01|w=380]]

[[11_提示音样本.wav#t=00:00]]

---

## 步骤 9：全格式直达验收（13 种格式）

请逐一点击以下所有格式链接，验证打开视图（含 **PDF 默认原生预览**）、跳转定位与伴生笔记是否正常：

- [ ] `.md` 标题锚点：[[01_项目需求拆解.md#2. 核心接口列表]]
- [ ] `.txt` 纯文本：[[02_纯文本备忘.txt]]
- [ ] `.py` 源码视图（确认 `#` 注释不会变成巨大 H1 标题）：[[03_核心脚本示例.py]]
- [ ] `.json` 配置视图：[[04_配置清单.json]]
- [ ] `.xlsx` 无坐标打开：[[05_迭代进度表.xlsx]]
- [ ] `.xlsx` 带坐标定位：[[05_迭代进度表.xlsx#任务进度!B3]]
- [ ] `.pdf` 无页码打开（默认原生 PDF 预览）：[[06_产品方案简报.pdf]]
- [ ] `.pdf` 指定第 2 页：[[06_产品方案简报.pdf#page=2]]
- [ ] `.docx` 文档预览：[[07_接口文档.docx]]
- [ ] `.pptx` 幻灯片第 2 页：[[08_评审幻灯片.pptx#Slide 2]]
- [ ] `.zip` 虚拟压缩包树：[[09_发布资源包.zip]]
- [ ] `.zip` 包内单文件直达：[[09_发布资源包.zip!README.txt]]
- [ ] `.png` 图片预览：[[10_架构示意.png]]
- [ ] `.wav` 音频播放器（`t=00:00`）：[[11_提示音样本.wav#t=00:00]]
- [ ] `.mp4` 视频播放器（`t=00:01`）：[[12_短片演示.mp4#t=00:01]]
- [ ] 外部网页链接：[[url:GitHub 主页|https://github.com]]
- [ ] 本机外部应用：[[app:记事本]]

---

## 步骤 10：灵动岛专注计时回写 Excel

- [ ] 点击顶部 **灵动岛专注计时**，完成或提前结束一次专注，测试将记录自动回写到 [[05_迭代进度表.xlsx]]
"""


def _req_breakdown_md() -> str:
    return """# 01 · 项目需求拆解

本文件用于配合 [[00_V6全流程实测清单.md]] 验证跨文件标题锚点、下划线边界标题、Hover Peek 悬停速览与 Ctrl+Click 分屏阅读。

---

## Chapter1 架构设计

SmartLocalNote V6 采用 **Thin Routes + Thick Core** 架构：

1. **后端网关 (`api/*.py`)**：单路由严格控制在 15 行以内，只负责参数校验与统一 `{ ok, data, message }` 封装。
2. **核心引擎 (`core/*.py`)**：零 FastAPI 依赖，全部本地读写经由 `core/safe_io.py` 路径白名单与 `.bak` 快照保护。
3. **前端工作台 (`static/js/*.js`)**：纯原生 ES6 Modules + CSS Design Tokens，零构建链冷启动。

---

## _下划线_边界测试

> 本章节特意在标题首尾和中间包含 `_` 下划线符号，用于验证锚点解析与目录定位不会被 Markdown 斜体正则误伤。

测试要点：
- 从 `[[01_项目需求拆解.md#_下划线_边界测试]]` 点击跳转时，应准确滚动定位到本标题。
- 关联进度表：[[05_迭代进度表.xlsx#任务进度!B3]]
- 关联方案简报：[[06_产品方案简报.pdf#page=2]]

---

## 2. 核心接口列表

| 接口路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/files/read` | GET | 读取多格式文档与伴生笔记 |
| `/api/files/expand-content` | GET | 抽取文件片段为 Markdown 供一键填入 |
| `/api/system/seed-test-suite` | POST | 一键初始化/重置 V6 全格式实测流程包 |
"""


def _plain_txt() -> str:
    return (
        "02 · 纯文本备忘录\n"
        "====================\n\n"
        "1. 今日实测目标：\n"
        "   - 验证 .txt 文件打开速度与 UTF-8 中文显示。\n"
        "   - 验证编辑后自动生成 data/.snapshots/ 备份快照。\n\n"
        "2. 关联文档提示：\n"
        "   - 返回总清单：[[00_V6全流程实测清单.md]]\n"
        "   - 查看接口文档：[[07_接口文档.docx]]\n"
    )


def _sample_py() -> str:
    return '''# -*- coding: utf-8 -*-
"""03 · 核心脚本示例（用于验证源码视图渲染，# 注释不应被误解析为 Markdown H1 标题）."""

from pathlib import Path
import json


# 1. 初始化路径安全检查
def summarize_tasks(config_path: str) -> dict:
    # 读取 JSON 配置文件并统计模块数
    raw = Path(config_path).read_text(encoding="utf-8")
    data = json.loads(raw)
    modules = data.get("supported_formats", [])
    return {
        "project": data.get("project", "SmartLocalNote"),
        "version": data.get("version", "6.0.0"),
        "format_count": len(modules),
    }


# 2. 计算任务进度统计
def calc_completion_rate(done: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((done / total) * 100.0, 1)


if __name__ == "__main__":
    print("SmartLocalNote V6 Source Code Preview OK ->", calc_completion_rate(12, 13))
'''


def _config_json() -> str:
    payload = {
        "project": "SmartLocalNote",
        "version": "6.0.0",
        "architecture": {
            "backend": "FastAPI + Thick Core (zero FastAPI in core/)",
            "frontend": "Vanilla ES6 Modules + CSS Design Tokens",
            "safe_io": "Whitelist + Atomic Replace + Max 15 .bak Snapshots",
        },
        "supported_formats": [
            ".md", ".txt", ".py", ".json", ".xlsx", ".pdf",
            ".docx", ".pptx", ".zip", ".png", ".wav", ".mp4",
        ],
        "test_entry": "00_V6全流程实测清单.md",
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def _make_zip_bytes(preview_png: bytes) -> bytes:
    readme = (
        "SmartLocalNote V6 发布资源包 (README.txt)\n"
        "==========================================\n\n"
        "本压缩包用于测试虚拟压缩包浏览、包内单文件跳转 [[09_发布资源包.zip!README.txt]]\n"
        "以及右键「一键展开内容填入」功能。\n\n"
        "包含文件：\n"
        "1. README.txt  - 本说明文档\n"
        "2. config.yaml - 样例 YAML 配置\n"
        "3. preview.png - 内嵌预览缩略图\n"
    )
    config_yaml = (
        "suite: smartlocalnote-v6\n"
        "mode: local-first\n"
        "features:\n"
        "  - wysiwyg_editor\n"
        "  - notchdrop_shelf\n"
        "  - sticky_notes_v6\n"
        "  - archive_virtual_tree\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.txt", readme.encode("utf-8"))
        zf.writestr("config.yaml", config_yaml.encode("utf-8"))
        zf.writestr("preview.png", preview_png)
    return buf.getvalue()


def generate_all(output_dir: Path = SEED_DIR) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    # Remove stale seed files before regenerating
    for existing in output_dir.iterdir():
        if existing.is_file():
            existing.unlink()

    diagram_png = _make_png_bytes(480, 260, variant=0)
    thumb_png = _make_png_bytes(96, 64, variant=1)

    files_map: dict[str, bytes] = {
        "00_V6全流程实测清单.md": _checklist_md().encode("utf-8"),
        "01_项目需求拆解.md": _req_breakdown_md().encode("utf-8"),
        "02_纯文本备忘.txt": _plain_txt().encode("utf-8"),
        "03_核心脚本示例.py": _sample_py().encode("utf-8"),
        "04_配置清单.json": _config_json().encode("utf-8"),
        "05_迭代进度表.xlsx": _make_xlsx_bytes(),
        "06_产品方案简报.pdf": _make_pdf_bytes(),
        "07_接口文档.docx": _make_docx_bytes(),
        "08_评审幻灯片.pptx": _make_pptx_bytes(),
        "09_发布资源包.zip": _make_zip_bytes(thumb_png),
        "10_架构示意.png": diagram_png,
        "11_提示音样本.wav": _make_wav_bytes(),
        "12_短片演示.mp4": _make_mp4_bytes(),
    }

    written: list[Path] = []
    for fname, data in files_map.items():
        fpath = output_dir / fname
        fpath.write_bytes(data)
        written.append(fpath)
    return written


if __name__ == "__main__":
    created = generate_all()
    total_size = sum(p.stat().st_size for p in created)
    print(f"Generated {len(created)} V6 test fixtures in {SEED_DIR} (total {total_size} bytes):")
    for p in created:
        print(f"  - {p.name} ({p.stat().st_size} bytes)")
