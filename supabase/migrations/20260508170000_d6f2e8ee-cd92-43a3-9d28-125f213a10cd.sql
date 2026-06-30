SET LOCAL session_replication_role = 'replica';
DELETE FROM mensagens WHERE atendimento_id = '11111111-aaaa-1111-aaaa-111111111111';
DELETE FROM atendimentos WHERE id = '11111111-aaaa-1111-aaaa-111111111111';
SET LOCAL session_replication_role = 'origin';