// Request validation shared by server (enforced) and client (friendly early feedback).
import { z } from 'zod';
import { ACCENTS, REACTIONS } from './theme.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const time = z.string().regex(/^\d{2}:\d{2}$/, 'Use a valid time');
const minutes = z.number().int().min(1).max(100_000);
const text = (max: number) => z.string().trim().max(max);
const title = z.string().trim().min(1, 'Please add a title').max(140);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Usernames need at least 3 characters')
  .max(24, 'Usernames can be up to 24 characters')
  .regex(/^[a-z0-9_.]+$/, 'Use letters, numbers, dots or underscores');

export const passwordSchema = z
  .string()
  .min(8, 'Passwords need at least 8 characters')
  .max(200);

const accent = z.string().refine((k) => k in ACCENTS, 'Unknown colour');
const avatar = z.object({
  accessory: z.enum(['none', 'glasses', 'stethoscope', 'headphones', 'leaf', 'bow']).optional(),
  mood: z.enum(['happy', 'calm', 'sleepy']).optional(),
});

const email = z.string().trim().toLowerCase().email('Please enter a valid email address').max(254);

export const signUpSchema = z.object({
  email,
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Please tell us your name').max(40),
  profileType: z.enum(['engineer', 'doctor', 'custom']),
  accent: accent.optional(),
  bio: text(200).optional(),
  avatar: avatar.optional(),
  timezone: z.string().max(64).optional(),
});

export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Please enter your password').max(200),
});

export const forgotPasswordSchema = z.object({
  email,
  redirectTo: z.string().url().max(500),
});

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'The two passwords do not match', path: ['confirm'] });

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  profileType: z.enum(['engineer', 'doctor', 'custom']).optional(),
  accent: accent.optional(),
  bio: text(200).optional(),
  avatar: avatar.optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  timezone: z.string().max(64).optional(),
  shareStatus: z.boolean().optional(),
});

export const roomCreateSchema = z
  .object({
    friendId: z.string().min(1),
    name: z.string().trim().min(1, 'Please name your room').max(80),
    description: text(300).optional(),
    startDate: date,
    endDate: date,
    color: accent.optional(),
  })
  .refine((r) => r.endDate >= r.startDate, { message: 'The end date must be after the start date', path: ['endDate'] });

export const roomUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: text(300).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  color: accent.optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const topicCreateSchema = z.object({
  title,
  description: text(1000).optional(),
  category: text(60).optional(),
  estimatedMinutes: minutes.nullable().optional(),
  sessionTargetMinutes: minutes.max(600).nullable().optional(),
  deadline: date.nullable().optional(),
});

export const topicUpdateSchema = topicCreateSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
});

export const reorderSchema = z.object({ topicIds: z.array(z.string()).min(1).max(500) });

export const sessionStartSchema = z.object({
  topicId: z.string().min(1),
  targetMinutes: minutes.max(600).nullable().optional(),
  remindAfterHour: z.boolean().optional(),
  taskId: z.string().nullable().optional(),
});

export const sessionFinishSchema = z.object({
  completeTopic: z.boolean().optional(),
  confirmLong: z.boolean().optional(),
  correctedMinutes: z.number().int().min(0).max(24 * 60).optional(),
  note: text(1000).optional(),
});

export const sessionUpdateSchema = z.object({
  note: text(1000).optional(),
  remindAfterHour: z.boolean().optional(),
  targetMinutes: minutes.max(600).nullable().optional(),
});

export const sessionCorrectSchema = z.object({
  minutes: z.number().int().min(0).max(24 * 60),
  reason: text(200).optional(),
});

const sprintLength = z.number().int().min(1, 'At least 1 day').max(60, 'Up to 60 days');

export const planCreateSchema = z.object({
  title,
  startDate: date,
  sprintDays: sprintLength,
});

export const planUpdateSchema = z.object({
  title: title.optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const sprintCreateSchema = z.object({ days: sprintLength.optional() });
export const sprintUpdateSchema = z.object({ days: sprintLength });

export const planTaskCreateSchema = z.object({
  day: z.number().int().min(0).nullable(), // null = straight into the backlog
  title,
  estMinutes: minutes.max(24 * 60).nullable().optional(),
});

export const planTaskUpdateSchema = z.object({
  day: z.number().int().min(0).nullable().optional(),
  title: title.optional(),
  estMinutes: minutes.max(24 * 60).nullable().optional(),
  starred: z.boolean().optional(),
});

export const pullSprintSchema = z.object({ roomId: z.string().min(1, 'Choose a room') });

export const taskCreateSchema = z.object({
  title,
  description: text(1000).optional(),
  date,
  startTime: time.nullable().optional(),
  durationMinutes: minutes.max(24 * 60).nullable().optional(),
  roomId: z.string().nullable().optional(),
  topicId: z.string().nullable().optional(),
  shared: z.boolean().optional(),
  note: text(1000).optional(),
});

export const taskUpdateSchema = taskCreateSchema.partial().extend({
  completed: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const encourageSchema = z.object({
  recipientId: z.string().min(1),
  reaction: z.enum(Object.keys(REACTIONS) as [keyof typeof REACTIONS, ...(keyof typeof REACTIONS)[]]).optional(),
  message: text(280).optional(),
  roomId: z.string().nullable().optional(),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TopicCreateInput = z.infer<typeof topicCreateSchema>;
