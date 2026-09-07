import tseslint from 'typescript-eslint'

/**
 * P2-2：lint 的作用不是风格警察，是**类型系统兜不住的那几类真 bug**：
 *
 *  - `no-floating-promises` / `no-misused-promises`：这个代码库里到处是手工
 *    `void` 标注的异步调用；漏一个就是"错误被吞掉、回合静默失败"。
 *  - `no-non-null-assertion`：`client!` 现有 5 处，是驱动抽象缺失（P1-2）的
 *    类型层症状。先按 warn 计数、不阻塞 CI；等 SessionDriver 落地后归零再转 error。
 *  - `require-await` / `await-thenable`：抓"看起来异步其实不是"的假异步。
 *
 * 前端 `public/assets/*.js` 暂不纳入（无类型信息、体量大），等 P2-1 的拆分与
 * `// @ts-check` 落地后再接。
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-release/**', 'node_modules/**', 'public/**', 'data/**', 'workspaces/**', 'notes/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // —— 真 bug 类：直接 error ——
      '@typescript-eslint/no-floating-promises': 'error',
      // 参数位不检：fastify 的 preHandler / 钩子类型签名是 void 返回，但运行时
      // 确实会 await 它们——在这里报错只会淹掉真正的“把 async 函数给了不等待方”。
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',

      // —— 债务计数类：warn，不阻塞 CI（清零后再升级为 error）——
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // 多余的类型断言：真该清，但属于纯清理；先计数，别混进安全批次
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      // 上游帧是 unknown 树，日志里刻意宽松地拼字符串（translate.ts 全篇如此）；
      // 这条规则在这里只会制造噪音，掩盖真问题
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',

      // —— 与本项目既有写法冲突、且无安全含义的规则：关掉 ——
      // 注释里大量中文与设计随笔，模板字符串里拼数字/布尔是常态
      '@typescript-eslint/restrict-template-expressions': 'off',
      // catch (error: unknown) + instanceof Error 是本项目的既定写法
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // tsc 的 noUnusedLocals/noUnusedParameters 已经在管
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // `node:test` 的 test() 返回 Promise，不 await 是它的惯用法（runner 自己收集）；
    // 在测试文件里把它当"悬挂 promise"报错只会淹掉生产代码里的真问题。
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // 测试里 await 一个非 async 的桩、throw 一个非 Error 的对象都无害：计数不拦
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },
)
