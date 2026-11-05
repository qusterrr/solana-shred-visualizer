import struct
import unittest

from app.shred import (
    COMMON_HEADER_SIZE,
    ShredType,
    detect_shred_type,
    parse_shred_header,
)


class ShredParserTests(unittest.TestCase):
    def create_payload(
        self,
        *,
        variant: int,
        slot: int,
        index: int,
        version: int,
        fec_set_index: int,
    ) -> bytes:
        payload = bytearray(COMMON_HEADER_SIZE)

        payload[64] = variant

        struct.pack_into(
            "<Q",
            payload,
            65,
            slot,
        )

        struct.pack_into(
            "<I",
            payload,
            73,
            index,
        )

        struct.pack_into(
            "<H",
            payload,
            77,
            version,
        )

        struct.pack_into(
            "<I",
            payload,
            79,
            fec_set_index,
        )

        return bytes(payload)

    def test_parse_common_header(self):
        payload = self.create_payload(
            variant=0xA5,
            slot=423_633_196,
            index=517,
            version=1234,
            fec_set_index=512,
        )

        shred = parse_shred_header(payload)

        self.assertEqual(
            shred.slot,
            423_633_196,
        )

        self.assertEqual(
            shred.index,
            517,
        )

        self.assertEqual(
            shred.version,
            1234,
        )

        self.assertEqual(
            shred.fec_set_index,
            512,
        )

        self.assertEqual(
            shred.shred_type,
            ShredType.DATA,
        )

    def test_legacy_code(self):
        self.assertEqual(
            detect_shred_type(0x5A),
            ShredType.CODE,
        )

    def test_legacy_data(self):
        self.assertEqual(
            detect_shred_type(0xA5),
            ShredType.DATA,
        )

    def test_merkle_code(self):
        self.assertEqual(
            detect_shred_type(0x43),
            ShredType.CODE,
        )

        self.assertEqual(
            detect_shred_type(0x67),
            ShredType.CODE,
        )

    def test_merkle_data(self):
        self.assertEqual(
            detect_shred_type(0x84),
            ShredType.DATA,
        )

        self.assertEqual(
            detect_shred_type(0xB2),
            ShredType.DATA,
        )

    def test_short_packet_rejected(self):
        with self.assertRaises(ValueError):
            parse_shred_header(
                b"\x00" * 50
            )


if __name__ == "__main__":
    unittest.main()