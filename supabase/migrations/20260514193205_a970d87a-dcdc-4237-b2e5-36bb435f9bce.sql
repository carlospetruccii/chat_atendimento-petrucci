
DROP POLICY IF EXISTS clients_update_admin ON public.clients;

CREATE POLICY clients_update_authenticated
ON public.clients
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);
