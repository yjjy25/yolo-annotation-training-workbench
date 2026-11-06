# MaixCAM 导出模式

在“模型转换与量化”选择“MaixCAM / Pro（YOLO26 → MaixHub）”，选择 PT，确认宽、高后开始转换。默认宽 320、高 224；每边须为 32 的倍数。模式固定使用 ONNX FP32、opset 17、batch 1、静态输入及 simplify=True，显式设置 nms=False，以保留当前 Ultralytics 的 YOLO26 one2one 检测分支。

当前仅支持标准 YOLO26 Detect：末层 model.23、reg_max=1、三个尺度并保留 one2one 权重。分割、姿态、旋转框、其他家族及改变检测头位置的自定义网络会拒绝导出。MaixHub 官方还支持部分其他检测家族，但本模式尚未实现其专用检查。MaixCAM2 需按对应文档适配。

导出隔离在项目 exports 的独立目录，不覆盖源 PT。完成前检查 ONNX、实际输入高宽、六个 one2one Conv 输出名称及通道/尺度，并执行 CPU 推理检查有限值。检查失败会记录失败原因，不显示完成。导出记录包含参数、版本、源及结果 SHA256、节点形状和输出形状。

结果目录包含 `maixcam-yolo26-fp32.onnx`、`labels.txt`、`MaixCAM使用说明.md`、`export.json` 和 `export.log`。类别顺序取自 PT；最终输出可以为 [1,300,6]，MaixHub 使用内部六个检测节点。

将 ONNX 上传到 https://maixhub.com/toolbox/convert/maixcam ，选择 YOLO26、实际板型及正确的类别/预处理设置。准备 20～100 张具有代表性的真实图片 ZIP（≤100 MB，不需要标注），完成云端量化后下载 .mud 与 .cvimodel，一起部署到 MaixCAM / Pro。请使用真实图片检查板端精度与速度。

本地模式仅准备和检查兼容 ONNX；没有自动上传、云端编译或板端精度保证。此次问题权重已在 Ultralytics 8.4.178 验证；官方文档推荐 8.4.104。版本变化导致节点名或分支变化会被检查拦截，请保留日志和 export.json 排查。

官方文档：https://wiki.sipeed.com/maixpy/doc/zh/ai_model_converter/online_converter.html
