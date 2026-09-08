import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { hash } from "bcryptjs";
import { unauthorized, notFound, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:user');

const userUpdateSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional().nullable(),
});

export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
                // Do not return password
            }
        });

        if (!user) {
            return notFound("User not found");
        }

        logger.debug({ user }, 'Returning user profile');

        return NextResponse.json(user);
    } catch (error) {
        logger.error({ error }, 'Failed to fetch user profile');
        return internalError("Failed to fetch user profile");
    }
}

export async function PATCH(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const body = await req.json();
        const { name, email, password, educationStage, enrollmentYear } = userUpdateSchema.parse(body);

        const updateData: any = {};

        // 只有非空字符串才会触发更新
        if (name && name.trim()) updateData.name = name.trim();
        if (educationStage && educationStage.trim()) updateData.educationStage = educationStage.trim();
        if (typeof enrollmentYear === 'number' && !isNaN(enrollmentYear)) {
            updateData.enrollmentYear = enrollmentYear;
        }

        // 验证邮箱格式（如果提供了邮箱）
        // 支持三种形式：
        //   标准邮箱      user@example.com
        //   本地邮箱      admin@localhost
        //   本地账户名    admin（默认管理员，不带 @）
        // 注意：旧版正则强制要求 @，导致默认管理员 admin 无法保存任何资料
        // （含教育阶段），因为设置面板会回传当前邮箱。
        if (email && email.trim()) {
            const trimmedEmail = email.trim();
            const isStandardEmail = /^[^\s@]+@[^\s@]+$/.test(trimmedEmail);
            const isLocalAccount = /^[^\s@]+$/.test(trimmedEmail);

            if (!isStandardEmail && !isLocalAccount) {
                return badRequest("Invalid email format");
            }

            // 邮箱未变更时直接跳过：既避免自撞唯一约束，也避免无谓写库
            if (trimmedEmail !== session.user.email) {
                const emailTaken = await prisma.user.findUnique({
                    where: { email: trimmedEmail },
                    select: { id: true },
                });
                if (emailTaken) {
                    return badRequest("Email already in use");
                }
                updateData.email = trimmedEmail;
            }
        }

        // 验证密码长度（如果提供了密码）
        if (password && password.length > 0) {
            if (password.length < 6) {
                return badRequest("Password must be at least 6 characters");
            }
            updateData.password = await hash(password, 10);
        }

        const updatedUser = await prisma.user.update({
            where: { email: session.user.email },
            data: updateData,
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
            }
        });

        return NextResponse.json(updatedUser);
    } catch (error) {
        logger.error({ error }, 'Failed to update user profile');
        if (error instanceof z.ZodError) {
            return validationError("Invalid input", error.issues);
        }
        return internalError("Failed to update user profile");
    }
}
