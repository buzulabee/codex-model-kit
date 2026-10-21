import { directStatus } from "../catalog/parameters.js";
import {
  reasonMessages,
  probeAdvice,
  type ProbeResult,
} from "../shared/workbench.js";
export function ProbeEvidence({
  id,
  result,
}: {
  id: string;
  result: ProbeResult;
}) {
  return (
    <>
      <p className="detail-model">{id}</p>
      <strong>{directStatus(id, result).label}</strong>
      <p role="status">{reasonMessages[result.reasonCode]}</p>
      <dl className="test-metrics">
        <dt>原因类别</dt>
        <dd>{result.reasonCode}</dd>
        <dt>检测时间</dt>
        <dd>{new Date(result.checkedAt).toLocaleString()}</dd>
        <dt>耗时</dt>
        <dd>{result.elapsedMs} ms</dd>
        <dt>首次事件</dt>
        <dd>
          {result.firstEventMs === null
            ? "未收到"
            : `${result.firstEventMs} ms`}
        </dd>
        <dt>Responses 协议</dt>
        <dd>
          {
            {
              supported: "基础请求支持",
              unsupported: "本次不支持",
              unknown: "无法确认",
            }[result.protocolResult]
          }
        </dd>
        <dt>流式结构</dt>
        <dd>
          {
            {
              valid: "通过",
              invalid: "本次不符合",
              unknown: "无法确认",
            }[result.streamResult]
          }
        </dd>
        <dt>事件 / 有效输出</dt>
        <dd>
          {result.eventCount} 个 / {result.outputObserved ? "已收到" : "未收到"}
        </dd>
        <dt>结束方式</dt>
        <dd>
          {
            {
              completed: "正常完成",
              incomplete: "未完成",
              failed: "服务返回失败事件",
              eof: "流提前结束",
              json: "普通 JSON（非流式）",
              cancelled: "已取消",
              error: "请求异常",
            }[result.end]
          }
        </dd>
      </dl>
      <p>
        <strong>建议：</strong>
        {probeAdvice(result.reasonCode)}
      </p>
      <p>
        这是固定短文本的基础 Responses
        流式检测，不验证图片、工具调用或全部思考等级。显示安全分类后的原因，不展示可能含凭据的服务商原始响应。一次失败不代表模型永久不可用。
      </p>
    </>
  );
}
