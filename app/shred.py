from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import struct


SIGNATURE_SIZE = 64

VARIANT_OFFSET = 64
SLOT_OFFSET = 65
INDEX_OFFSET = 73
VERSION_OFFSET = 77
FEC_SET_INDEX_OFFSET = 79

COMMON_HEADER_SIZE = 83


class ShredType(str, Enum):
    DATA = "data"
    CODE = "code"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class ShredHeader:
    slot: int
    index: int
    version: int
    fec_set_index: int
    variant: int
    shred_type: ShredType

    def to_dict(self) -> dict:
        return {
            "slot": self.slot,
            "index": self.index,
            "version": self.version,
            "fec_set_index": self.fec_set_index,
            "variant": f"0x{self.variant:02x}",
            "shred_type": self.shred_type.value,
        }


def detect_shred_type(variant: int) -> ShredType:
    # Legacy variants
    if variant == 0xA5:
        return ShredType.DATA

    if variant == 0x5A:
        return ShredType.CODE

    # Merkle variants.
    #
    # Code:
    #   0b0100_????
    #   0b0110_????
    #   0b0111_????
    #
    # Data:
    #   0b1000_????
    #   0b1001_????
    #   0b1011_????
    high_nibble = variant & 0xF0

    if high_nibble in {0x40, 0x60, 0x70}:
        return ShredType.CODE

    if high_nibble in {0x80, 0x90, 0xB0}:
        return ShredType.DATA

    return ShredType.UNKNOWN


def parse_shred_header(payload: bytes) -> ShredHeader:
    if len(payload) < COMMON_HEADER_SIZE:
        raise ValueError(
            f"Packet is too short: {len(payload)} bytes, "
            f"expected at least {COMMON_HEADER_SIZE}"
        )

    variant = payload[VARIANT_OFFSET]

    slot = struct.unpack_from("<Q", payload, SLOT_OFFSET)[0]
    index = struct.unpack_from("<I", payload, INDEX_OFFSET)[0]
    version = struct.unpack_from("<H", payload, VERSION_OFFSET)[0]
    fec_set_index = struct.unpack_from(
        "<I",
        payload,
        FEC_SET_INDEX_OFFSET,
    )[0]

    return ShredHeader(
        slot=slot,
        index=index,
        version=version,
        fec_set_index=fec_set_index,
        variant=variant,
        shred_type=detect_shred_type(variant),
    )