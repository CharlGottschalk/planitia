import { z } from 'zod';

/** The schema the `validate` tool checks payloads against. Replace this example with your own. */
export const schema = z.object({
  email: z.email(),
  age: z.number().int().min(0),
  tags: z.array(z.string()).max(10).optional(),
});
