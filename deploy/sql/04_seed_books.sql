INSERT INTO books (id, owner_id, "userId", name, source, "wordCount", "tierCount", "listSize", status, "createdAt")
VALUES ('book_cet6_full', 'system_seed', 'system_seed', '六级全量', 'builtin', 5407, 4, 50, 'active', now())
ON CONFLICT (id) DO NOTHING;