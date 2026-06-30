INSERT INTO public.departments (nome, cor, ativo)
SELECT 'Administrativo', '#A855F7', true
WHERE NOT EXISTS (SELECT 1 FROM public.departments WHERE nome = 'Administrativo');