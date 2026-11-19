# 联办台演练接口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /dispatch/H-406` 热线任务，分项键在诉求内有效。affectedScope 是服务地点代码。
- `GET /enterprise/live?after=8` after 是企业投递偏移。next 是本页之后的查询位置，missing 是暂不可见偏移区间。
- `GET /enterprise/replay?from=9&to=10` from、to 是闭区间投递偏移。凭证 P-16 指明承接域，源工单和目标工单各有命名空间。
- `GET /enterprise/findings` 证据号指向更正前后可核对的企业处理说明。
- `POST /hotline/replies` requestKey 为发送方的回告身份。另需 caseId、part、text，可用 priorReceipt 引用已受理回告。
- `GET /hotline/replies` 以 requestKey 查受理编号，未进入可见阶段只有受理状态。
