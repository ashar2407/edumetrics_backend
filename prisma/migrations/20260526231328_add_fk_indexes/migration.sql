-- CreateIndex
CREATE INDEX "Assessment_classId_idx" ON "Assessment"("classId");

-- CreateIndex
CREATE INDEX "Class_userId_idx" ON "Class"("userId");

-- CreateIndex
CREATE INDEX "Score_studentId_idx" ON "Score"("studentId");

-- CreateIndex
CREATE INDEX "Score_assessmentId_idx" ON "Score"("assessmentId");

-- CreateIndex
CREATE INDEX "Student_classId_idx" ON "Student"("classId");
