const { PrismaClient } = require('@prisma/client');

// bcryptjs is required by this standalone seed script but is NOT part of the
// Next.js standalone bundle. Depending on how the package is resolved in the
// runtime image, the entry may be 'bcryptjs' or a sub-path. Try multiple
// candidates so the script never fails to load bcryptjs.
function loadBcrypt() {
    const candidates = ['bcryptjs', 'bcryptjs/index.js', 'bcryptjs/umd/index.js'];
    let lastErr;
    for (const c of candidates) {
        try {
            return require(c);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}
const bcrypt = loadBcrypt();
const { hash } = bcrypt;

// 默认管理员登录名（不带邮箱后缀，登录时直接输入 admin）
const DEFAULT_ADMIN_EMAIL = 'admin';
// 管理员密码：优先取容器环境变量 PASSWORD，否则使用内置默认密码 123456
const DEFAULT_ADMIN_PASSWORD = process.env.PASSWORD || '123456';
// 旧版本默认账户名，用于升级时平滑迁移
const OLD_DEFAULT_ADMIN_EMAIL = 'admin@localhost';

const DEFAULT_ADMIN = {
    email: DEFAULT_ADMIN_EMAIL,
    password: DEFAULT_ADMIN_PASSWORD,
    name: 'Admin',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

async function seedAdmin({ prisma, hash: hashPassword }) {
    // 兼容升级：旧版本默认账户为 admin@localhost，迁移到不带邮箱的 admin
    const oldAdmin = await prisma.user.findUnique({
        where: { email: OLD_DEFAULT_ADMIN_EMAIL },
    });
    const newExists = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN_EMAIL },
    });
    if (oldAdmin && !newExists) {
        await prisma.user.update({
            where: { email: OLD_DEFAULT_ADMIN_EMAIL },
            data: { email: DEFAULT_ADMIN_EMAIL },
        });
    }

    const existingUser = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN.email },
    });

    if (existingUser) {
        // 已存在：仅在显式设置 PASSWORD 时更新密码，否则保留现有密码
        const data = {
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: existingUser.educationStage ?? DEFAULT_ADMIN.educationStage,
            enrollmentYear: existingUser.enrollmentYear ?? DEFAULT_ADMIN.enrollmentYear,
        };
        if (process.env.PASSWORD) {
            data.password = await hashPassword(DEFAULT_ADMIN.password, 12);
        }
        await prisma.user.update({
            where: { email: DEFAULT_ADMIN.email },
            data,
        });
        return { action: 'updated', email: DEFAULT_ADMIN.email };
    }

    const hashedPassword = await hashPassword(DEFAULT_ADMIN.password, 12);

    await prisma.user.create({
        data: {
            email: DEFAULT_ADMIN.email,
            password: hashedPassword,
            name: DEFAULT_ADMIN.name,
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: DEFAULT_ADMIN.educationStage,
            enrollmentYear: DEFAULT_ADMIN.enrollmentYear,
        },
    });

    return { action: 'created', email: DEFAULT_ADMIN.email };
}

async function main() {
    const prisma = new PrismaClient();

    try {
        const result = await seedAdmin({ prisma, hash });
        if (result.action === 'created') {
            console.log('Success! Admin user created.');
            console.log(`Login: ${result.email}`);
            console.log(
                process.env.PASSWORD
                    ? 'Password: (set via PASSWORD env)'
                    : `Password: ${DEFAULT_ADMIN.password}`
            );
        } else {
            console.log('Admin user already exists. Updated defaults.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { seedAdmin, DEFAULT_ADMIN };
