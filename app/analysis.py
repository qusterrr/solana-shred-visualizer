"""Compute FEC statistics for the observed arrivals in one slot."""

from app.shred import ShredType


DECODE_THRESHOLD = 32


def analyze_slot(slot: int, events: list[dict]) -> list[dict]:
    groups: dict[int, list[dict]] = {}
    for event in events:
        if event["slot"] != slot:
            raise ValueError("FEC analysis requires arrivals from a single slot")
        groups.setdefault(event["fec_set_index"], []).append(event)

    results = []
    for fec_set_index, arrivals in sorted(groups.items()):
        data_indices: set[int] = set()
        coding_indices: set[int] = set()
        indices_by_type = {
            ShredType.DATA: data_indices,
            ShredType.CODE: coding_indices,
        }
        data_arrivals = 0
        coding_arrivals = 0
        cumulative = []
        decode_time_ms = None

        # The slot query provides rows in insertion order for timestamp ties.
        for event in sorted(arrivals, key=lambda event: event["arrival_us"]):
            shred_type = event["shred_type"]
            indices = indices_by_type.get(shred_type)
            if indices is None:
                continue

            data_arrivals += shred_type == ShredType.DATA
            coding_arrivals += shred_type == ShredType.CODE
            shred_index = event["shred_index"]
            if shred_index in indices:
                continue

            indices.add(shred_index)
            count = len(data_indices) + len(coding_indices)
            cumulative.append({
                "arrival_ms": event["arrival_ms"],
                "count": count,
                "shred_type": shred_type,
                "shred_index": shred_index,
            })
            if count == DECODE_THRESHOLD:
                decode_time_ms = event["arrival_ms"]

        recognized = data_arrivals + coding_arrivals
        unique = len(data_indices) + len(coding_indices)
        results.append({
            "fec_set_index": fec_set_index,
            "total_arrivals": len(arrivals),
            "recognized_arrivals": recognized,
            "unique_recognized_shred_count": unique,
            "duplicate_arrival_count": recognized - unique,
            "data_arrival_count": data_arrivals,
            "coding_arrival_count": coding_arrivals,
            "unique_data_shred_count": len(data_indices),
            "unique_coding_shred_count": len(coding_indices),
            "cumulative_unique_points": cumulative,
            "decode_time_ms": decode_time_ms,
        })

    return results
