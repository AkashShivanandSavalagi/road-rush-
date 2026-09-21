name = "road-rush"
main = "worker.js"
compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "ROOM_AUTHORITY"
class_name = "RoomAuthority"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomAuthority"]  # SQLite-backed DO, per the confirmed Free-plan availability
