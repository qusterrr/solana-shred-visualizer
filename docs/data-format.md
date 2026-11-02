# Wire-format shred log format

The existing Rust `wire-format` collector stores Turbine shred arrival
metadata in binary `time_log_*.bin` files.

Each record is 25 bytes and uses little-endian encoding.

| Field | Type | Size |
|---|---|---:|
| timestamp_us | uint64 | 8 bytes |
| slot | uint64 | 8 bytes |
| index | uint32 | 4 bytes |
| sender_ip | uint32 | 4 bytes |
| flags | uint8 | 1 byte |

Total record size: 25 bytes.

## Flags

The `flags` field is a bit mask.

- Bit 0 (`0x01`): repair shred
- Bit 1 (`0x02`): multicast
- Bit 2 (`0x04`): coding shred

## FEC grouping

The existing plotter derives the FEC group from the stored index:

```text
fec_index = index // 64