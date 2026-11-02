# GitHub 提交计划

老师看的是提交记录：要有若干次提交，有修改记录。下面把项目拆成 14 次提交，建议分 3~5 天做，每次提交前自己读一遍对应的文件（讲解单里有说明）。**每一步之间最好自己动手改一点东西**（见文末），这样提交记录里才有你自己的修改。

## 第 0 步：准备

1. 注册 GitHub，新建一个仓库，例如 `dine-in-order`（选 Public 或 Private 都可以，Private 要把老师加为协作者）。
2. 本地设置身份（只需要一次）：

   ```
   git config --global user.name "你的 GitHub 用户名"
   git config --global user.email "你的 GitHub 邮箱"
   ```
3. 进入项目文件夹，初始化并关联仓库（把地址换成你自己的）：

   ```
   git init -b main
   git remote add origin https://github.com/你的用户名/dine-in-order.git
   ```

## 提交步骤

每一步都是：`git add 文件…` → `git commit -m "说明"` → 偶尔 `git push -u origin main`（第一次用 `-u`）。

1. 项目骨架
   ```
   git add package.json .gitignore data/.gitkeep README.md
   git commit -m "chore: 初始化项目，添加运行说明"
   ```
2. 数据库
   ```
   git add src/config.js src/errors.js src/db.js
   git commit -m "feat(db): 设计表结构并写入演示菜单和账号"
   ```
3. 登录和角色
   ```
   git add src/auth.js
   git commit -m "feat(auth): 实现顾客登录、员工登录和 token 校验"
   ```
4. 菜单和价格
   ```
   git add src/menu.js
   git commit -m "feat(menu): 菜品、规格、价格计算、售罄、菜品管理"
   ```
5. 模拟支付
   ```
   git add src/mockpay.js
   git commit -m "feat(pay): 添加 MockPay 模拟微信支付适配器"
   ```
6. 订单核心
   ```
   git add src/orders.js
   git commit -m "feat(order): 订单状态机、取餐号、支付确认(onPaid 幂等)、追加、退款、定时任务"
   ```
7. 二维码
   ```
   git add src/qr.js
   git commit -m "feat(qr): 生成店内统一点餐码（SVG）"
   ```
8. 接口层和入口
   ```
   git add src/app.js server.js
   git commit -m "feat(api): 接口层路由、角色校验、统一返回格式，添加启动入口"
   ```
9. 自动化测试（此时后端已经完整，可以 `npm test` 看到通过）
   ```
   git add test/api.test.js
   git commit -m "test: 添加 27 个接口和流程测试（后来又加了 2 个）"
   ```
10. 顾客端
    ```
    git add public/index.html public/css public/js/common.js public/js/customer.js public/manifest.webmanifest public/icons
    git commit -m "feat(customer): 顾客端菜单、规格、购物车、模拟支付、订单页"
    ```
11. 店员端
    ```
    git add public/staff.html public/js/staff.js public/manifest-staff.webmanifest
    git commit -m "feat(staff): 店员端新订单提醒、出餐流程、售罄管理、退款"
    ```
12. 店长端
    ```
    git add public/manager.html public/js/manager.js public/manifest-manager.webmanifest
    git commit -m "feat(manager): 店长端菜品、分类、员工、订单查询、异常处理"
    ```
13. 点餐码页面
    ```
    git add public/qr.html
    git commit -m "feat(qr): 点餐码页面"
    ```
14. 文档
    ```
    git add docs
    git commit -m "docs: 代码讲解单、与设计文档的差异说明"
    ```
    最后 `git push`。

## 新增功能的提交建议

这几个功能比较独立，适合分给两个人各自提交（谁做的谁提交，并且要能讲清楚）：

- 语音叫号：`public/js/staff.js` → `feat(staff): 点完成时语音叫号`
- 取餐提醒：`public/js/customer.js` → `feat(customer): 订单完成时弹窗、提示音、震动`
- 营业统计：`src/orders.js`、`src/app.js`、`public/js/manager.js` → `feat(manager): 当日营业额统计`
- 图片上传：`src/app.js`、`src/config.js`、`public/js/manager.js` → `feat(manager): 菜品图片上传`
- 扩充菜单：`src/db.js` → `feat(db): 增加汤类、凉菜类、饮品类和更多菜品`
- 新增的 2 个测试：`test/api.test.js` → `test: 营业统计和图片上传`

## 自己动手改的建议（每次改完单独提交）

这些改动都很小，改完运行一下，能体会代码是怎么工作的：

- 改 `src/config.js` 里的 `PAY_TIMEOUT_MIN`（15 分钟）为别的数字，看订单关闭时间变化 → `fix(config): 调整未支付关闭时间`
- 改 `src/db.js` 里的演示菜单，加一两个你喜欢的菜 → `feat(db): 增加演示菜品`
- 改 `public/css/app.css` 里的 `--brand` 颜色 → `style: 调整顾客端主题色`
- 改 `public/js/customer.js` 里的提示文字，例如“如需取消订单，请联系店员” → `docs: 修改提示文案`
- 改 `public/index.html` 的标题成你的店名 → `feat: 修改店铺名称`
- 在 `test/api.test.js` 里自己加一个测试（例如：下单数量 100 份应被拒绝） → `test: 增加数量上限测试`
- 修改 `README.md`，补上你自己运行时遇到的问题和解决办法 → `docs: 补充运行问题记录`

## 提醒

- 提交说明用中文或英文都可以，写清楚“做了什么”。
- 每次提交后，用 `git log --oneline` 看一下记录是否正常。
- 如果组里有别的成员，各自用各自的账号提交自己负责的部分；如果是你一个人做，也建议分几天提交，不要一次全部提交。
